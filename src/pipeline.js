// pipeline.js — the full run (fetch → score → triage → brief → deliver),
// plus `query` and `audit`. Used by both the CLI (index.js) and the web
// server's built-in scheduler (server.js).

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";

import * as store from "./store.js";
import { collectAll } from "./collect.js";
import { scoreItems } from "./score.js";
import { triageItems } from "./triage.js";
import { generateBrief } from "./brief.js";
import { saveBrief, postToTeams, sendEmail, sendAlertEmail, sendMemoEmail } from "./deliver.js";
import { detectChanges } from "./alerts.js";
import { adapters, classOf, sourceIdsForClass } from "./adapters/index.js";
import { syncRegistryFromSeed } from "./registry.js";
import { EDUCATION_SYSTEM_PROMPT, seedCurriculum } from "./curriculum.js";
import { signalsText } from "./signals.js";
import { weatherRiskText } from "./weather.js";
import { crushText } from "./crush.js";
import { leadLagText } from "./leadlag.js";
import { upcomingReportsText, upcomingReports, upcomingPolicyEventsText } from "./calendar.js";
import { fetchDocumentText } from "./summarize.js";
import { emailBodyToText } from "./emailhtml.js";
import { evaluateTriggers, triggersText } from "./triggers.js";
// compliance.js is intentionally NOT imported here — it's decoupled (platform split 2026-07-11)
// and reserved for the future farmer-facing tool. Bean Brief's internal outputs run un-muzzled.
import { mapPool } from "./util.js";
import { enrichItems, groundNewsItems } from "./enrich.js";
import { rankNewsItems } from "./newsrank.js";
import { eventKeyFor, groupByEvent, pickLead } from "./eventkey.js";

// How many market adapters to refresh at once — independent hosts, so the phase is the slowest
// adapter, not the sum. (Open-Meteo's OWN per-region calls stay serial; only adapters overlap.)
const SERIES_CONCURRENCY = 6;

/** The live watchlist file: the data-volume copy in Docker/Umbrel, else the project one. */
export function watchlistFilePath() {
  const candidates = [path.join(store.DATA_DIR, "watchlist.json"), path.join(store.PROJECT_ROOT, "watchlist.json")];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(`Could not find watchlist.json (looked in ${candidates.join(" and ")})`);
  }
  return found;
}

// --- Focus areas -----------------------------------------------------------
// The watchlist is organized into FOCUS AREAS (issue buckets the analyst thinks
// in). Each has a single flat `terms` list used BOTH to search sources and to
// score/tag items, plus an `appliesTo` list of source ids. The collect/score/
// triage engine still consumes the older per-topic shape, so we derive that view
// on load (deriveEngineTopics) and strip it again on save.

/** All known source ids — a focus area with no `appliesTo` applies to all of them. */
const ALL_SOURCE_IDS = Object.keys(adapters);

/** Convert a legacy "topics" array (keywords + per-source queries) into focus areas. */
function migrateTopicsToFocusAreas(topics) {
  return (topics ?? []).map((t) => ({
    id: t.id,
    label: t.label,
    weight: t.weight ?? 5,
    enabled: t.enabled !== false,
    terms: [...new Set([...(t.keywords ?? []), ...Object.values(t.queries ?? {}).flat()])],
    appliesTo: [...ALL_SOURCE_IDS],
  }));
}

/**
 * The engine (collect/score/triage/adapters) consumes a topic shape:
 *   { id, label, weight, keywords, queries: { [sourceId]: string[] } }
 * Derive it from focus areas — the flat `terms` list serves as both keywords
 * (scoring) and per-source queries (collection), for every source it applies to.
 *
 * A focus area may narrow what a METERED source searches for via an optional
 *   sourceTerms: { [sourceId]: string[] }
 * override. Scoring always uses the full flat `terms` list; only the outbound
 * queries shrink. This exists because a term list is cheap to score against but
 * expensive to search with: legiscan bills one API query per (term × state), so
 * firing federal-only vocabulary ("farm bill", "USTR", "RVO") at seven state
 * legislatures burned quota on searches that can never match. Setting
 * `sourceTerms.legiscan` to the genuinely state-legislative terms keeps recall
 * where it pays and stops the rest.
 *
 * NOTE: terms added to a focus area in the Watchlist UI land in `terms` only — a
 * source with a `sourceTerms` override won't search them until that list is edited
 * too. That's deliberate (the override is a budget), but it's a real footgun.
 */
function deriveEngineTopics(focusAreas) {
  return (focusAreas ?? [])
    .filter((fa) => fa.enabled !== false)
    .map((fa) => {
      const applies = fa.appliesTo && fa.appliesTo.length ? fa.appliesTo : ALL_SOURCE_IDS;
      const terms = fa.terms ?? [];
      const queries = {};
      for (const sid of applies) queries[sid] = fa.sourceTerms?.[sid] ?? terms;
      // excludeTerms are NOT queried — they only subtract during local scoring (see score.js).
      return { id: fa.id, label: fa.label, weight: fa.weight ?? 5, keywords: terms, queries, excludeTerms: fa.excludeTerms ?? [] };
    });
}

/** Ensure focusAreas exist (migrating legacy topics) and attach the derived engine view. */
export function normalizeWatchlist(w) {
  if (!Array.isArray(w.focusAreas) || w.focusAreas.length === 0) {
    w.focusAreas =
      Array.isArray(w.topics) && w.topics.length ? migrateTopicsToFocusAreas(w.topics) : w.focusAreas ?? [];
  }
  w.topics = deriveEngineTopics(w.focusAreas); // engine view; stripped again on save
  return w;
}

/** Persist watchlist edits from the web UI. The derived engine `topics` view is never written. */
export function saveWatchlist(watchlist) {
  const { topics, ...persist } = watchlist; // drop the derived engine view before writing
  void topics;
  const target = watchlistFilePath();
  const data = JSON.stringify(persist, null, 2) + "\n";
  // Atomic write: a bare writeFileSync truncates the live file first, so a crash mid-write leaves
  // the whole config corrupt. Write a sibling temp in the SAME directory, then rename onto the
  // target — rename is atomic within one filesystem, so a reader (or the next boot) sees either the
  // intact old file or the fully-written new one, never a torn one. The .<pid>.<uuid> suffix avoids
  // collisions between concurrent writers; on failure we remove the temp and rethrow, leaving the
  // original untouched.
  const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort temp cleanup */ }
    throw err;
  }
}

export function loadWatchlist() {
  const watchlistPath = watchlistFilePath();
  let text;
  try {
    // strip a UTF-8 BOM if present — Windows Notepad/PowerShell add one, and JSON.parse rejects it
    text = fs.readFileSync(watchlistPath, "utf8").replace(/^﻿/, "");
  } catch (err) {
    throw new Error(`Could not read ${watchlistPath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `watchlist.json is not valid JSON: ${err.message}\n   Tip: check for a missing comma or quote, or paste the file into jsonlint.com`
    );
  }
  return normalizeWatchlist(parsed);
}

function printScoredTable(kept, dropped) {
  if (kept.length === 0) {
    console.log("   (no items passed the local filter)");
    return;
  }
  const rows = kept.map((item) => ({
    score: item.localScore,
    source: item.sourceId,
    juris: item.jurisdiction,
    topics: item.matchedTopics.map((t) => t.id).join(", ") || "—",
    title: item.title.length > 70 ? item.title.slice(0, 67) + "..." : item.title,
  }));
  console.table(rows);
  console.log(`   (${dropped} below threshold or over cap — dropped locally, cost $0)`);
}

/** The whole show: fetch → score → (triage → brief → deliver unless dry run). */
/**
 * Refresh market timeseries (for the Markets charts) from every adapter that exposes a
 * fetchSeries() — idempotent upsert into store.market_series. Fail-soft per adapter.
 */
export async function refreshMarketSeries(env = process.env) {
  let watchlist = {};
  try { watchlist = loadWatchlist(); } catch { /* no watchlist → refresh everything */ }
  const seriesAdapters = Object.values(adapters).filter(
    (a) => typeof a.fetchSeries === "function" && watchlist.sources?.[a.id]?.enabled !== false
  );

  // Refresh adapters concurrently (bounded). Fail-soft per adapter; the saveSeriesPoints() writes
  // are synchronous (better-sqlite3) so they serialize safely even though the fetches overlap.
  const counts = await mapPool(seriesAdapters, SERIES_CONCURRENCY, async (adapter) => {
    try {
      // Pass the adapter's watchlist entry through, same as collect does for fetchItems — it lets a
      // series adapter take per-deployment tuning without a code change (e.g. cbot_futures'
      // hullsUsdPerTon, usda_ams' incremental-window size).
      const list = await adapter.fetchSeries({ env, sourceConfig: watchlist.sources?.[adapter.id] ?? {} });
      let n = 0;
      for (const s of list) {
        store.saveSeriesPoints(s.series, s.meta, s.points);
        n++;
      }
      if (list.length) console.log(`📈 ${adapter.label}: refreshed ${list.length} market series`);
      return n;
    } catch (err) {
      console.log(`⚠️  ${adapter.label} series refresh failed: ${err.message}`);
      return 0;
    }
  });
  const seriesCount = counts.reduce((a, n) => a + n, 0);
  try {
    const stale = store.seriesFreshness().filter((r) => r.stale);
    if (stale.length) console.log(`🟠 Data health: ${stale.length} series overdue — ${stale.slice(0, 6).map((s) => s.label).join(", ")}`);
  } catch {
    /* freshness check is best-effort */
  }
  return seriesCount;
}

/**
 * Detect material market changes → the "what changed" alert feed. Emails the digest only when
 * opted in (watchlist output.alertEmail) and SMTP is configured. Returns the new alerts.
 */
export async function runAlertsCheck(env = process.env, output = null) {
  let changes = [];
  try {
    changes = detectChanges();
  } catch (err) {
    console.log(`⚠️  Change detection skipped: ${err.message}`);
    return [];
  }
  if (changes.length) {
    console.log(`🔔 ${changes.length} market change alert${changes.length === 1 ? "" : "s"}: ${changes.slice(0, 4).map((c) => c.title).join("; ")}${changes.length > 4 ? "…" : ""}`);
    if (output?.alertEmail === true) {
      try {
        if (await sendAlertEmail(changes, env)) console.log("   📧 alert digest emailed");
      } catch (err) {
        console.log(`⚠️  Alert email failed: ${err.message}`);
      }
    }
  }
  return changes;
}

export async function runPipeline({ edition = "am", dryRun = false, source = null, env = process.env }) {
  const watchlist = loadWatchlist();

  console.log(`\n🌱 The Bean Brief ${dryRun ? "(dry run — no Anthropic calls)" : `— ${edition} edition`}\n`);

  // Keep the entity registry current so entity-driven adapters (rss/email-intake)
  // have their channels even on a bare CLI/cron run (the server also syncs on startup).
  // Idempotent; also means registry.json edits apply on the next run, no restart needed.
  try {
    const r = syncRegistryFromSeed();
    if (r.entities) console.log(`🗂️  Registry: ${r.entities} entities, ${r.channels} channels synced`);
  } catch (err) {
    console.log(`⚠️  Registry sync skipped: ${err.message}`);
  }
  // Event keys for pre-existing history (idempotent — NULLs only), so a CLI/cron run sees the same
  // grouped world the web UI does.
  try {
    store.backfillEventKeys();
  } catch (err) {
    console.log(`⚠️  Event-key backfill skipped: ${err.message}`);
  }

  // 1. Collect. Dry runs never write state (no last-success advance, no items marked seen).
  const { items, skippedSources, fetchedCount, pendingWatermarks } = await collectAll({
    watchlist,
    env,
    onlySource: source,
    commit: !dryRun,
  });

  // 1b. Split by information class. Only "official" (regulatory/legal) sources feed the
  // policy pipeline (score → triage → brief). "news" (collector/press) and "markets"
  // (demand data) items are stored for their own tabs but NEVER enter the policy brief —
  // that's what keeps the Items/brief flow clean even when they hit a policy keyword
  // (e.g. EIA "soybean oil → biodiesel" would otherwise match the biofuels area).
  const officialItems = [];
  const sideItems = [];
  for (const it of items) (classOf(it.sourceId) === "official" ? officialItems : sideItems).push(it);

  // 1b-i. GROUND THE OFFICIAL ITEMS IN THEIR DOCUMENTS, then give every item its event identity.
  //
  // Order matters and is deliberate. Enrichment runs BEFORE scoring so the retrieved abstract counts
  // toward the local keyword score (a docket whose title is generic but whose abstract says
  // "soybean" used to score zero and never reach triage). And it runs before the event key is
  // computed because the same request that fetches the document text also returns the Federal
  // Register document number that keys cross-filed copies together.
  //
  // No Anthropic tokens are spent here and every fetch is individually fail-soft, so the worst case
  // is that items proceed exactly as the adapters produced them — which is the old behaviour.
  if (officialItems.length) {
    try {
      const { items: enriched } = await enrichItems(officialItems, { env });
      officialItems.length = 0;
      officialItems.push(...enriched);
    } catch (err) {
      console.log(`⚠️  Document enrichment skipped: ${err.message}`);
    }
  }
  // 1b-ii. GROUND THE NEWS ITEMS IN THEIR ARTICLES — the same fix, for the stream that carries more
  // than half the corpus.
  //
  // Must run BEFORE the markSeen below, because that write is what persists `summary` into `body`.
  // Measured on the stored feed: 60 of 68 news rows held under 200 characters, so retrieval (which
  // weights a body hit) and every prompt (whose `document` field IS body) were working from a
  // truncated teaser. The text was already being fetched once a run by generateNewsDigest and thrown
  // away; this keeps it. Markets items are excluded deliberately — they are data points, not
  // articles, and have no readable page to fetch.
  if (!dryRun && sideItems.length) {
    const newsIdx = sideItems.map((it, i) => (classOf(it.sourceId) === "news" ? i : -1)).filter((i) => i >= 0);
    if (newsIdx.length) {
      try {
        const { items: grounded } = await groundNewsItems(newsIdx.map((i) => sideItems[i]), {});
        newsIdx.forEach((i, k) => { sideItems[i] = grounded[k]; });
      } catch (err) {
        console.log(`⚠️  News grounding skipped: ${err.message}`);
      }
    }
  }

  for (const it of [...officialItems, ...sideItems]) {
    it.raw = { ...(it.raw ?? {}), eventKey: eventKeyFor(it) };
  }

  // 1b-iii. RANK THE NEWS (1.28.0) — graded relevance for the stream that had none.
  //
  // ⚠️ ORDERING IS LOAD-BEARING AND EASY TO GET WRONG. The verdicts must be computed BEFORE the
  // markSeen below, and each news item must be marked seen EXACTLY ONCE, carrying its verdict.
  // `markSeen(it, null)` writes triage_verdict='unscored' and one_line=NULL, so a ranking pass that
  // ran after it — or a second markSeen(null) alongside it — would silently erase every verdict and
  // the whole feature would appear to do nothing.
  //
  // ⚠️ NO LOCAL SCORE GATE. scoreItems is used ONLY to attach `matchedTopics` as a hint for the model.
  // Measured on the real corpus, gating news at localScore >= 5 drops "USMCA renewal rejected"
  // (score 0), "USDA releases June 2026 Acreage Report and Grain Stocks" (score 0) and "Crop progress:
  // Soybean quality fades lower" (score 3) — 3 of the 8 highest-value items — because focus-area terms
  // are written for policy documents and news says the same things in different words. See newsrank.js.
  const newsVerdicts = new Map();
  if (!dryRun && sideItems.length) {
    const newsItems = sideItems.filter((it) => classOf(it.sourceId) === "news");
    if (newsItems.length) {
      try {
        // minLocalScoreForTriage 0 + no cap: this call classifies, it does not filter.
        const { kept } = scoreItems(newsItems, watchlist.topics ?? [], {
          ...watchlist.output,
          minLocalScoreForTriage: 0,
          maxItemsToTriage: Number.MAX_SAFE_INTEGER,
        });
        // Honour the analyst's global exclusion terms: an excluded item is stored and still appears in
        // the inbox in time order, but we don't spend a model call ranking something he has said he
        // doesn't care about, and it can never be promoted.
        const toRank = kept.filter((it) => it.excludedBy !== "global");
        const nExcluded = kept.length - toRank.length;
        if (nExcluded) console.log(`   ${nExcluded} news item${nExcluded === 1 ? "" : "s"} skipped by exclusion terms (stored, not ranked)`);
        const { verdicts } = await rankNewsItems(toRank, watchlist.topics ?? [], env);
        for (const [uid, v] of verdicts) newsVerdicts.set(uid, v);
      } catch (err) {
        // A ranking failure must never cost the mail. Items fall through unranked below.
        console.log(`⚠️  News ranking skipped: ${err.message}`);
      }
    }
  }

  if (!dryRun && sideItems.length) {
    // News rows carry their verdict; markets rows stay unscored (they are data points, not documents).
    for (const it of sideItems) store.markSeen(it, newsVerdicts.get(it.uid) ?? null);
    console.log(`🗂️  Stored ${sideItems.length} news/markets item${sideItems.length === 1 ? "" : "s"} for their tabs (kept out of the brief).`);
  }

  // 1c. Refresh market timeseries (Markets charts) from any adapter exposing fetchSeries,
  //     then detect material changes → the "what changed" alert feed (event-driven).
  if (!dryRun) {
    await refreshMarketSeries(env);
    await runAlertsCheck(env, watchlist.output);
    try {
      await generateNewsDigest(env);
    } catch (err) {
      console.log(`⚠️  News digest skipped: ${err.message}`);
    }
    try {
      await extractMarketIntel(env);
    } catch (err) {
      console.log(`⚠️  Market-intel extraction skipped: ${err.message}`);
    }
    try {
      await generateMarketCards(env);
    } catch (err) {
      console.log(`⚠️  Market cards skipped: ${err.message}`);
    }
    try {
      await generateStorylines(env);
    } catch (err) {
      console.log(`⚠️  Storylines skipped: ${err.message}`);
    }
    // Judge any forecasts whose horizon has elapsed. Pure arithmetic over stored series — no model
    // call, no cost — so it rides the heartbeat rather than needing its own schedule.
    try {
      resolveForecasts();
    } catch (err) {
      console.log(`⚠️  Forecast resolution skipped: ${err.message}`);
    }
    // Pre-report consensus in, surprises out. Extraction costs one cheap Haiku call; scoring is free.
    try {
      await extractExpectations(env);
    } catch (err) {
      console.log(`⚠️  Expectation extraction skipped: ${err.message}`);
    }
    try {
      computeSurprises();
    } catch (err) {
      console.log(`⚠️  Surprise scoring skipped: ${err.message}`);
    }
  }

  // 2. Local scoring — free, runs before Claude sees anything.
  console.log(`\n🔎 Scoring ${officialItems.length} new item${officialItems.length === 1 ? "" : "s"}…`);
  const { kept, dropped, excluded } = scoreItems(officialItems, watchlist.topics ?? [], watchlist.output);
  console.log(`   ${kept.length} pass the local filter (min score ${watchlist.output?.minLocalScoreForTriage ?? 5})`);
  // Say what the exclusion list removed. A filter that silently swallows items is one nobody can
  // debug later — and this is the number to watch after adding a term.
  if (excluded) console.log(`   ${excluded} dropped by exclusion terms (watchlist output.excludeTerms / per-area excludeTerms)`);

  if (dryRun) {
    printScoredTable(kept, dropped);
    // Say how many of those rows are the same government action, since that is what a real run
    // would spend triage tokens on — a dry run that reports 19 items where 17 would be triaged is
    // reporting the old, misleading number.
    const nActions = groupByEvent(kept).length;
    if (nActions < kept.length) {
      console.log(`\n🔗 ${kept.length} filings are ${nActions} distinct actions — ${kept.length - nActions} would inherit a verdict instead of being triaged again.`);
    }
    if (skippedSources.length > 0) {
      console.log(`\n⚠️  Skipped sources: ${skippedSources.map((s) => s.label).join(", ")}`);
    }
    console.log("\n✅ Dry run complete — nothing was saved, no Anthropic calls were made.\n");
    return { dryRun: true, kept, skippedSources };
  }

  return runFullPipeline({ watchlist, env, edition, kept, items: officialItems, skippedSources, fetchedCount, pendingWatermarks });
}

// Rough list prices per 1M tokens, for the audit cost estimate only.
// Update if Anthropic pricing changes — this affects nothing but the printout.
const PRICES = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
};

export async function runFullPipeline({ watchlist, env, edition, kept, items, skippedSources, fetchedCount, pendingWatermarks = [] }) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in .env — get one at console.anthropic.com (or use --dry-run to test without it)");
  }

  // 3. Haiku triage on the locally-filtered survivors — ONE VERDICT PER ACTION.
  //
  // A single Federal Register notice cross-filed into four EPA dockets used to be triaged four
  // times: four Haiku calls' worth of tokens spent to produce four differently-worded one-liners
  // about the same document, which then appeared as four rows in the feed and four entries on the
  // calendar. Grouping by event key (eventkey.js) sends one representative — the copy with real
  // document text, preferring the publisher of record — and then writes that verdict to the other
  // copies, so the whole group agrees instead of disagreeing at random.
  const groups = groupByEvent(kept);
  for (const g of groups) {
    g.lead = pickLead(g.members);
    g.lead.eventFilings = g.members.length; // told to the model, and shown in the feed
  }
  const leads = groups.map((g) => g.lead);
  const collapsed = kept.length - leads.length;
  console.log(
    `\n🤖 Triage (${env.TRIAGE_MODEL || "claude-haiku-4-5"}): sending ${leads.length} item${leads.length === 1 ? "" : "s"}` +
      (collapsed ? ` (${kept.length} filings collapsed onto ${leads.length} distinct actions — ${collapsed} duplicate call${collapsed === 1 ? "" : "s"} avoided)` : "") +
      `…`
  );
  const { relevant, verdicts } = await triageItems(leads, watchlist.topics ?? [], env);
  console.log(`   ${relevant.length} relevant`);

  // Apply each lead's verdict to the copies that were not sent. They keep their own uid, url and
  // docket so nothing is lost or merged in the database — they simply inherit the judgement made
  // about the document they are all copies of.
  let inherited = 0;
  for (const g of groups) {
    if (g.members.length < 2) continue;
    if (!verdicts.has(g.lead.uid)) continue; // lead never reached the model — leave the copies unseen so the next run retries
    const verdict = verdicts.get(g.lead.uid);
    for (const m of g.members) {
      if (m.uid === g.lead.uid) continue;
      store.markSeen(m, verdict);
      inherited++;
    }
  }
  if (inherited) console.log(`   ↳ ${inherited} duplicate filing${inherited === 1 ? "" : "s"} inherited their action's verdict`);

  // 3b. Flag movement on tracked items (pinned in the web UI) — these always
  // make the brief and get their own 📌 section.
  const trackedKeys = store.trackedKeySet();
  if (trackedKeys.size > 0) {
    for (const item of relevant) {
      const stableKey = item.raw?.billId ? `legiscan-bill:${item.raw.billId}` : item.uid;
      item.tracked = trackedKeys.has(stableKey) || trackedKeys.has(item.uid);
    }
    const moved = relevant.filter((i) => i.tracked).length;
    if (moved > 0) console.log(`   📌 ${moved} tracked item${moved === 1 ? "" : "s"} with new activity`);
  }

  // Anything fetched but not triaged (dropped by local scoring) is still recorded
  // as seen, so it is never re-processed. Core cost-discipline rule.
  const keptUids = new Set(kept.map((i) => i.uid));
  for (const item of items) {
    if (!keptUids.has(item.uid)) store.markSeen(item, null);
  }

  // Watermark commit point. Every item fetched this run should now be durably in seen_items — side
  // items (news/markets) above, triaged items during triage, locally-dropped items just now. ONLY here
  // is it safe to advance each source's last_success_at: collect deferred these instead of writing them
  // mid-fetch, so if the run had died earlier (missing ANTHROPIC_API_KEY at runFullPipeline entry, an
  // Anthropic 429/5xx during triage, a crash) the watermarks stay put and the next run re-fetches —
  // isSeen dedupes the survivors. ts is each source's fetch-start, so nothing published during the
  // run is skipped. Prevents silent, permanent data loss.
  //
  // ⚠️ VERIFY THE INVARIANT, DON'T ASSUME IT (1.28.0). This loop used to advance every watermark
  // unconditionally, which was safe only while every code path above really did mark every item seen.
  // 1.28.0's triage change broke that assumption: an unparseable batch now leaves its items UNSEEN so a
  // later run can retry them — but advancing the cursor past them means the retry never happens and the
  // items exist in no table at all. Reproduced end to end: a congress_gov bill whose triage batch failed
  // twice was absent from seen_items while `getSince("congress_gov")` moved from 6 hours ago to this
  // run's start, so the next fetch (`fromDateTime`, filtering on updateDate) could never return it.
  // Silent, permanent loss — strictly worse than the crash it replaced, which at least left the
  // watermark alone.
  //
  // So the durability claim is now CHECKED rather than trusted, generically: any source with an item
  // this run that is not in seen_items keeps its old watermark. That covers the failed-triage-batch
  // case, the "lead never reached the model so its copies stay unseen" case above (whose copies may
  // belong to a DIFFERENT source than the lead, since one FR notice is cross-filed across sources), and
  // any future path that leaves something unseen. `isSeen` is a primary-key lookup and there are ≤ a
  // few hundred items, so the check is negligible. Withholding costs exactly one re-fetch.
  const unseenSources = new Set();
  for (const item of items) {
    if (!store.isSeen(item.uid)) unseenSources.add(item.sourceId);
  }
  for (const { sourceId, ts } of pendingWatermarks) {
    if (unseenSources.has(sourceId)) {
      console.log(`   ⏸️  ${sourceId}: watermark held back — some items weren't stored this run, so the next run will re-fetch them`);
      continue;
    }
    store.setLastSuccess(sourceId, ts);
  }

  // 4. Sonnet brief — only when there's something to report. On a quiet scan we
  // skip the brief entirely: no file, no clutter in Saved briefs. The run still did
  // its real work above (collect + refresh markets/news/alerts/cards + triage), so
  // this stays the twice-daily heartbeat — it just no longer emits blank briefs.
  const stats = {
    fetchedCount,
    sourceCount: Object.keys(adapters).filter((s) => watchlist.sources?.[s]?.enabled).length,
    skippedSources,
  };
  if (relevant.length === 0) {
    console.log("\n📝 Nothing relevant this scan — no policy brief saved (quiet day). Markets/news/alerts refresh still ran.");
    console.log(`\n✅ ${edition.toUpperCase()} refresh complete — no brief today.\n`);
    return;
  }
  console.log(`\n📝 Generating brief (${env.BRIEF_MODEL || "claude-sonnet-5"})…`);
  const markdown = await generateBrief({ relevantItems: relevant, watchlist, edition, env, stats });

  // 5. Deliver.
  const timezone = watchlist.briefEditions?.timezone ?? "America/Chicago";
  const filePath = saveBrief(markdown, edition, timezone);
  let deliveredTo = [path.relative(store.DATA_DIR, filePath)];

  if (watchlist.output?.teams !== false) {
    try {
      if (await postToTeams(markdown, env)) deliveredTo.push("Teams");
    } catch (err) {
      console.log(`⚠️  Teams delivery failed: ${err.message}`);
    }
  }
  try {
    if (await sendEmail(markdown, edition, env, watchlist)) deliveredTo.push("email");
  } catch (err) {
    console.log(`⚠️  Email delivery failed: ${err.message}`);
  }

  // 5b. (Retired) The twice-daily farmer twin used to render here on every run. It's been
  // replaced by the on-demand "farmer" memo preset (generateMemo) — same audience, but
  // generated when asked over a chosen window, so the scheduled run never pays for it.

  console.log(`\n✅ Saved ${deliveredTo.join(" · posted to ")}\n`);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Series whose LEVEL percentile is structurally misleading and must not be read as "unusually high".
// These sit on a capacity/production base that has grown enormously, so the newest reading ratchets
// to a fresh record most years regardless of what demand is doing — the exact reason the old crush
// scorer printed "record-strong demand" for eight straight months while crush fell ~10%. Retiring the
// scorer was not sufficient: the raw statistic still reaches the model through this block, and the
// first live Analyst Note duly cited crush's "92nd pctile" alongside the utilization read as though
// the two corroborated each other. They don't — one is the artefact the other was built to replace.
const PERCENTILE_CAVEATS = {
  "nass:us:crush": "this is a percentile of crush VOLUME, which ratchets upward with the ~1.06M bu/day of capacity added since 2023 — it is NOT evidence of strong demand. Use the Crush Utilization signal, which divides by installed capacity, and ignore this rank.",
  "eia:feedstock:soybean-oil": "volume percentile on a feedstock base that has grown with renewable-diesel capacity — high ranks are largely structural, not a demand surprise.",
};

/**
 * Render the deep trend snapshot as compact, category-grouped lines — latest + change,
 * year-over-year, historical range/percentile, and a seasonal read — so the model can
 * teach trends (is this seasonally normal? how does it compare to years past?) from the
 * full history we store, not just the latest number.
 */
function formatMarketSnapshot(snapshot) {
  if (!snapshot || snapshot.length === 0) return "";
  const fmt = (v) => (v == null ? "—" : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(Number(Number(v).toFixed(2))));
  const pct = (v) => (v == null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
  const byCat = new Map();
  for (const s of snapshot) {
    const cat = s.category || "other";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(s);
  }
  const lines = [];
  for (const [cat, list] of byCat) {
    lines.push(`# ${cat}`);
    for (const s of list) {
      const parts = [`${fmt(s.latest.value)} ${s.unit} (${s.latest.period})`];
      // Percent deltas are suppressed on zero-crossing series (basis) where they'd be nonsense —
      // fall back to the absolute move so the model still sees the direction and size.
      if (s.changePct != null) parts.push(`Δ ${pct(s.changePct)} vs prior`);
      else if (s.changeAbs != null) parts.push(`Δ ${fmt(s.changeAbs)} ${s.unit} vs prior`);
      if (s.yoyPct != null) parts.push(`YoY ${pct(s.yoyPct)}`);
      parts.push(`range ${fmt(s.min.value)}–${fmt(s.max.value)}, now ${s.percentile}th pctile of ${s.count} obs since ${s.firstPeriod}`);
      // ⚠️ Two percentile caveats, stated inline because the model demonstrably compresses them away
      // otherwise. The first Analyst Note on live data reported "root-zone moisture at the 5th
      // percentile" (a rank inside 21 readings from one summer, presented as a historical extreme)
      // and quoted crush's "92nd pctile" as if it corroborated the utilization signal — the very
      // statistic that scorer was retired for. The count and start date were already in the line and
      // that was not enough; the warning has to be explicit.
      if (s.historyYears != null && s.historyYears < 2) {
        parts.push(`⚠️ percentile spans only ${s.historyYears} calendar year — it means "lowest/highest so far", NOT a historical extreme`);
      }
      const caveat = PERCENTILE_CAVEATS[s.series];
      if (caveat) parts.push(`⚠️ ${caveat}`);
      // MOMENTUM, in the series' own volatility units — lets the model distinguish "high and still
      // climbing" from "high but rolling over", which no level/percentile statistic can express.
      if (s.changeZ != null) parts.push(`last move ${s.changeZ >= 0 ? "+" : ""}${s.changeZ.toFixed(1)}σ of its typical swing`);
      if (s.slopePerSigma != null) {
        const dir = s.slopePerSigma > 0.15 ? "rising" : s.slopePerSigma < -0.15 ? "falling" : "flat";
        parts.push(`trend ${dir} (${s.slopePerSigma >= 0 ? "+" : ""}${s.slopePerSigma.toFixed(2)}σ/period over last 12)`);
      }
      if (s.seasonalDeltaPct != null) {
        const mon = MONTHS[(Number(s.latest.period.slice(5, 7)) || 1) - 1];
        // seasonalYears is stated because a 3-year "norm" deserves far less weight than a 10-year
        // one, and the model cannot tell them apart otherwise.
        parts.push(`seasonal ${pct(s.seasonalDeltaPct)} vs ${mon} avg across ${s.seasonalYears} yrs (${s.seasonalPctile}th pctile for ${mon})`);
      }
      let line = `- ${s.label}: ${parts.join("; ")}`;
      if (s.trail && s.trail.length > 1) line += ` — recent: ${s.trail.map((p) => fmt(p.value)).join(" → ")}`;
      lines.push(line);
    }
  }
  return lines.join("\n");
}

// Per-item document budget in the prompt context. Chosen from what the corpus actually contains:
// Federal Register abstracts run ~300–2,300 characters, so 1,200 carries most of them whole and
// truncates the rest after the operative paragraph. Multiplied by ~30 items this is ~9k tokens of
// document text — real money on Opus, which is why only the excerpt travels and the full body stays
// one click away in the UI.
const CONTEXT_BODY_CHARS = 1200;

/**
 * Project stored item rows into the LLM context — one entry per government ACTION, carrying the
 * document's own words.
 *
 * TWO THINGS THIS FIXES, both of which were load-bearing failures rather than polish:
 *
 * 1. **The body was dropped.** Every reasoning path — the Ask box, the Analyst Note, the weekly and
 *    monthly memos — ran its retrieved rows through this function, and it projected them to
 *    title + one_line. So the deepest model in the system reasoned about a Federal Register rule
 *    from its title and a sentence Haiku wrote about that title. The document text was in the
 *    database the whole time. (`extractMarketIntel` was built specifically to smuggle newsletter
 *    bodies past this bottleneck for the news stream; it is no longer the only way through.)
 *
 * 2. **Copies arrived as separate items.** Four rows titled "Pesticide Product Registration:
 *    Applications for New Uses (April 2026)" read to a model as four independent corroborating
 *    signals of the same thing — the textbook way to manufacture false confidence. They are now one
 *    entry that states how many dockets it was filed in, which is the fact that actually carries
 *    meaning.
 */
function compactItems(rows) {
  return groupByEvent(rows).map(({ members }) => {
    const h = pickLead(members);
    const doc = String(h.body ?? "").trim();
    const others = members.filter((m) => m.uid !== h.uid);
    return {
      title: h.title,
      url: h.url,
      source: h.source_id,
      jurisdiction: h.jurisdiction,
      why: h.one_line,
      verdict: h.triage_verdict,
      priority: h.triage_tier ?? undefined,
      seen: (h.first_seen_at || "").slice(0, 10),
      deadline: h.comment_deadline ? String(h.comment_deadline).slice(0, 10) : undefined,
      // The document's own words, explicitly labelled as such so the model can tell sourced text
      // from the triager's interpretation in `why`.
      document: doc ? doc.slice(0, CONTEXT_BODY_CHARS) + (doc.length > CONTEXT_BODY_CHARS ? " […]" : "") : undefined,
      // Same action, other filings. Named this way on purpose: "alsoFiledAs" reads as one thing in
      // several places, where a bare array of titles would read as several things.
      alsoFiledAs: others.length ? others.slice(0, 6).map((m) => `${m.source_id}: ${m.url || m.uid}`) : undefined,
    };
  });
}

/**
 * The master query engine: answer a question by retrieving across EVERY pipeline —
 * Laws/Rules/Decisions + News items, the demand-side MARKET timeseries, tracked items,
 * upcoming comment deadlines, and recent briefs — then one Sonnet call to synthesize
 * with citations. Shared by the CLI (`query`) and the homepage "Ask the Bean Brief" box.
 * @returns {{ answer: string, hits: object[] }}
 */
export async function answerQuery(question, env) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in .env — get one at console.anthropic.com");
  }

  // 1. Stored items (LRD + News), RANKED by how well they match the question — see
  //    store.searchItemsRanked for what the old path did wrong (in short: it dropped every
  //    2–3-character acronym, which in this domain means 45Z, RFS, RIN, EPA, SAF and WOTUS, then
  //    ordered whatever survived by date). The most recent relevant items are still UNIONed in
  //    *after* the ranked hits so open-ended questions ("what's new this week?") still work, but
  //    they no longer crowd out the answer to a specific one.
  const ranked = store.searchItemsRanked(question, { limit: 24 });
  // Keep the literal-phrase search as a second opinion: it catches a long exact quote that the
  // tokenizer splits, and it is one indexed scan.
  const literal = ranked.length < 8 ? store.searchSeenItems(question, 10) : [];
  // ⚠️ CLASS-SCOPED ON PURPOSE, with a separate news budget.
  //
  // This was one unscoped `listItems({verdict:"relevant", days:30, limit:12})`. That was harmless only
  // because news rows were all `unscored` and therefore invisible to it. Now that 1.28.0 grades news,
  // an unscoped query here would let the higher-volume news stream take most of those 12 recency slots
  // from the regulatory items — a silent regression in the Ask box, caused by an improvement elsewhere.
  // Two fixed budgets instead, so neither stream can starve the other, and news must be must_read to
  // occupy a slot it did not earn on the ranked search above.
  const recentOfficial = store.listItems({ verdict: "relevant", days: 30, limit: 12, sourceIds: sourceIdsForClass("official") });
  const recentNews = store.listItems({ verdict: "relevant", days: 14, limit: 6, tier: "must_read", sourceIds: sourceIdsForClass("news") });
  const merged = [...new Map([...ranked, ...literal, ...recentOfficial, ...recentNews].map((h) => [h.uid, h])).values()].slice(0, 40);
  const compactHits = compactItems(merged);

  // 2. Market data — the structured demand-side timeseries (price, crush, stocks, biofuel
  //    feedstock share, basis, fund positioning…). This is what makes the DATA queryable
  //    in plain English, not just visible as charts.
  const marketBlock = formatMarketSnapshot(store.marketSnapshot());

  // 3. Tracked (pinned) items + upcoming comment deadlines.
  const tracked = store.listTracked();
  const deadlines = store.upcomingDeadlines(20);

  // 4. Most recent few briefs as narrative context.
  const briefTexts = [];
  for (const b of store.listBriefs(4)) {
    const p = path.join(store.DATA_DIR, b.path);
    if (fs.existsSync(p)) briefTexts.push(`--- Brief ${b.path} ---\n${fs.readFileSync(p, "utf8").slice(0, 6000)}`);
  }

  if (compactHits.length === 0 && !marketBlock && briefTexts.length === 0) {
    return { answer: "Nothing stored yet matches. Run the pipeline a few times first.", hits: [] };
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.BRIEF_MODEL || "claude-sonnet-5";
  const system =
    "You are the senior market-and-policy analyst for an Iowa Soybean Association professional whose remit is BOTH policy and demand/markets. This is an INTERNAL analysis tool for staff — give a sharp, direct answer, not a hedged briefing. Draw on the stored monitoring data provided below, which spans three streams: (1) LAWS/RULES/DECISIONS + NEWS items, (2) MARKET DATA (soybean price, crush, stocks, biofuel feedstock share, basis, fund positioning, exports, barge freight, crop condition, weather), and (3) recent BRIEFS, plus tracked items and comment deadlines. The market data carries trend context per series — change vs. prior, year-over-year, the historical range with the latest value's percentile, and a seasonal read (vs. the same month across years). USE that context to explain trends and whether a value is seasonally normal or unusual, not just the latest number. Synthesize across streams — connect policy/trade developments to the market MECHANISM and the numbers, go second-order, and where the data supports it give a directional read: the most likely interpretation, the risk to it, and the report or data that would confirm or kill it. Distinguish FACT from your INTERPRETATION, and be honest about confidence rather than hedging into mush. Each item may carry a \"document\" field holding the source document's OWN words and a \"why\" field holding a prior one-line note about it — treat \"document\" as sourced fact and \"why\" as someone else's summary, and prefer the document when they differ. An item with \"alsoFiledAs\" is ONE action filed in several places, not several corroborating items — never treat repetition as evidence. If the substance of an item is not in its document text, say the substance was not retrieved rather than inferring it from the title. Cite item titles as markdown links when a URL is available; when you cite a market figure, name the series and its period (e.g. \"U.S. crush 210M bu, Apr 2026\"). Plain, professional English. You also have a WEB SEARCH tool — lean on the stored monitoring data first, but use the web to fill what it doesn't cover: the latest futures/cash prices, breaking news, or a figure or date worth verifying — anything more current than the last pipeline run. Reach for it when it makes the answer materially better or more current, not reflexively. Cite any web source inline as a markdown link so staff can tell web-sourced facts from the internal streams. Don't invent numbers — pull them.";
  const userContent =
    `Question: ${question}\n\n` +
    `=== MARKET DATA (latest value, change vs prior, recent trail) ===\n${marketBlock || "(no market data stored yet)"}\n\n` +
    (weatherRiskText() ? `=== CROP-WEATHER READ (anomaly vs. normal → supply/price) ===\n${weatherRiskText()}\n\n` : "") +
    (crushText() ? `=== CRUSH DEMAND (capacity utilization, cause→effect with margin) ===\n${crushText()}\n\n` : "") +
    (leadLagText() ? `=== MEASURED LEAD-LAG vs. DAILY PRICE (read the caveats) ===\n${leadLagText()}\n\n` : "") +
    (forecastTrackRecordText() ? `=== THIS TOOL'S OWN TRACK RECORD (past calls, scored) ===\n${forecastTrackRecordText()}\n\n` : "") +
    (surpriseText() ? `=== EXPECTATIONS vs. ACTUALS (surprise is what moves price, not the level) ===\n${surpriseText()}\n\n` : "") +
    (marketIntelText() ? `=== MARKET INTEL FROM NEWSLETTERS (distilled from the collector inbox, cited) ===\n${marketIntelText()}\n\n` : "") +
    `=== LAWS/RULES/DECISIONS + NEWS items (JSON — one entry per government ACTION; "document" is the source's own text, "why" is a prior note, "alsoFiledAs" means the same action filed elsewhere) ===\n${JSON.stringify(compactHits, null, 1)}\n\n` +
    `=== TRACKED ITEMS (pinned) ===\n${tracked.length ? tracked.map((t) => `- ${t.title}${t.jurisdiction ? ` (${t.jurisdiction})` : ""}${t.url ? ` ${t.url}` : ""}`).join("\n") : "(none)"}\n\n` +
    `=== UPCOMING COMMENT DEADLINES ===\n${deadlines.length ? deadlines.map((d) => `- ${d.comment_deadline}: ${d.title}${d.url ? ` ${d.url}` : ""}`).join("\n") : "(none)"}\n\n` +
    `=== RECENT BRIEFS ===\n${briefTexts.join("\n\n") || "(none)"}`;
  const messages = [{ role: "user", content: userContent }];
  // Web search is an Anthropic SERVER-side tool: the API runs the search loop and returns the final
  // answer — no client tool loop. A long server loop can stop with stop_reason "pause_turn"; re-send
  // to continue, bounded so it can't spin. web_search_20260209 needs Sonnet 5 / Opus 4.x (our
  // BRIEF_MODEL) and takes NO beta header. A search error returns as a result block, never a throw.
  let response;
  for (let turn = 0; turn < 4; turn++) {
    response = await client.messages.create({
      model,
      max_tokens: 4500, // headroom for Sonnet 5 adaptive thinking + a web-augmented, cited answer
      system,
      tools: env.WEB_SEARCH === "off" ? undefined : [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }], // WEB_SEARCH=off → stored-data-only
      messages,
    });
    store.recordUsage(model, "query", response.usage.input_tokens, response.usage.output_tokens);
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content }); // echo blocks back unchanged to resume
  }
  // Web-augmented answers can span several text blocks (interleaved with search-result blocks) — join them.
  const answer = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim() || "(no answer)";
  return { answer, hits: merged };
}

export async function runQuery(question, env) {
  console.log(`\n🔍 Searching stored briefs and items for: "${question}"…`);
  const { answer } = await answerQuery(question, env);
  console.log("\n" + answer + "\n");
}

// --- Memo mode ------------------------------------------------------------
// A "memo" is the master query engine run in report mode: the same cross-stream
// retrieval (items + market data + tracked + deadlines + briefs), but scoped to a
// time window and prompted to WRITE a structured memo for a given audience instead
// of answering a question. Weekly/monthly reports and the on-demand farmer update
// are all presets of this one engine — no separate feature per report type.
export const MEMO_PRESETS = {
  weekly: {
    label: "Weekly memo",
    edition: "weekly",
    scopeDays: 7,
    maxTokens: 6000,
    system: (dateLabel) => `You write The Bean Brief's WEEKLY policy & market memo for Iowa Soybean Association colleagues and board members who did not follow the daily flow. Use ONLY the stored monitoring data provided (laws/rules/decisions + news items, the market timeseries, tracked items, comment deadlines, recent briefs). Structure exactly:

## The Bean Brief — Weekly Memo (week ending ${dateLabel})

### The week in three sentences
### 📈 Markets & demand
What the market data did this week — crush, soybean & soy-oil prices, biofuel feedstock share, basis, fund positioning — with the numbers (name the series + period).
### 🏛️ Policy & regulatory
What changed in laws/rules/decisions and why it matters to Iowa soy.
### 🔴 What needs attention next week
Comment deadlines approaching, votes scheduled, rules expected.
### 📋 Everything else worth knowing
One line each.

Rules: never invent items or numbers; keep every markdown link; cite a market figure with its series + period; plain professional English; omit empty sections.`,
  },
  monthly: {
    label: "Monthly review",
    edition: "monthly",
    scopeDays: 30,
    maxTokens: 6000,
    system: (dateLabel) => `You write The Bean Brief's MONTHLY policy & market review for Iowa Soybean Association leadership — a higher-altitude "month in review," trends over the month, not a day-by-day list. Use ONLY the stored monitoring data provided. Structure exactly:

## The Bean Brief — Monthly Review (as of ${dateLabel})

### The month in five sentences
### 📈 Markets & demand — the trend
Where crush, prices, biofuel feedstock demand, basis and positioning moved over the month, with the numbers (name the series + period).
### 🏛️ Policy & regulatory — what shifted
The month's meaningful rule/bill/court developments and their direction of travel.
### 🔭 What we're watching
Comment deadlines, expected rules, decisions on the horizon.
### 📋 Notable items
One line each.

Rules: never invent items or numbers; keep every markdown link; cite a market figure with its series + period; plain professional English; omit empty sections.`,
  },
  education: {
    label: "Market-education brief",
    edition: "education",
    scopeDays: 3,
    maxTokens: 3000, // headroom for Sonnet 5's default adaptive thinking + the lesson
    injectCurriculum: true,
    // The stable "teach, don't tell" identity (§1) + the daily-brief task structure (§3).
    system: (dateLabel) => `${EDUCATION_SYSTEM_PROMPT}

TASK: Write today's BeanBrief daily market-education brief for Iowa Soybean Association staff who aren't grain-market experts, using ONLY the data context provided. Structure exactly:

## BeanBrief — Market Education, ${dateLabel}

### The lead
2–3 sentences: what mattered most in the market lately and — the important part — WHY. Anchor to the most significant data point. If a move was driven by a surprise vs. expectations, teach that.
### What moved
2–4 short items. Each: the fact (with source + date), then one or two sentences of plain explanation of the mechanism. Skip anything that doesn't help understanding today.
### Understanding today's market
One short paragraph teaching the assigned CONCEPT (provided below), tied to something in today's data so the lesson lands in context. Treat this as the most valuable part.
### Worth watching
1–2 bullets: what a staffer can now watch — the next report, a weather window, an export pace — and the read on which way it's likely to break and why.
### Today's terms
A one-line plain definition for any market term you used (draw from the glossary provided). Omit this block entirely if you introduced no term.

Length: scannable in ~90 seconds (250–400 words). No preamble, no sign-off. Start at the lead. Teach the mechanism, then give the read.`,
  },
  analyst: {
    label: "Analyst Note",
    edition: "analyst",
    scopeDays: 14,
    // The deep "around the corner" report runs on Opus 4.8 + adaptive thinking.
    // Thinking counts against max_tokens on Opus, so the ceiling sits well above
    // the ~2–3k-token note itself to leave room (still non-streaming-safe at 12k).
    // effort "high" is the recommended default. Override the model via ANALYST_MODEL.
    maxTokens: 12000,
    model: "claude-opus-4-8",
    modelEnv: "ANALYST_MODEL",
    thinking: { type: "adaptive" },
    effort: "high",
    injectSignals: true,
    web: true,
    // The Analyst Note is the one preset whose whole job is forward-looking falsifiable claims, so
    // it's the one worth filing in the forecast ledger. Weekly/monthly summarize the period and
    // education teaches — extracting "forecasts" from those would fill the ledger with restatements.
    extractForecasts: true,
    system: (dateLabel) => `You are the senior market-and-policy analyst for the Iowa Soybean Association's demand & policy team — an INTERNAL audience (sharp, no hand-holding, wants to see around the corner). Write a forward-looking ANALYST NOTE grounded in the stored data provided (the market signal board, full-history trend stats, laws/rules/decisions + news, the release calendar, tracked items, recent briefs). You also have a WEB SEARCH tool: when the stored data leaves a gap that matters to the read — a very recent development, a number more current than the last pipeline run, or a fact worth verifying — search for it, and cite any web source inline as a markdown link so it stands apart from the internal streams. Lean on the stored data first; reach for the web only when it sharpens the analysis.

Do NOT summarize the period. Do the analysis a headline can't give:
- Connect across streams — tie a policy/trade development to the market MECHANISM and the numbers (name the series, period, percentile, YoY, seasonal read).
- Go second-order — not "crush is at a record" but what that implies and what could break it.
- Be explicit about the SETUP, the RISK to that read, and the DATA OR REPORT THAT WOULD CONFIRM OR KILL IT.

Structure exactly:

## The Bean Brief — Analyst Note, ${dateLabel}

### The read
3–4 sentences: your current thesis on where soybean demand and price pressure are heading, and why.
### What the signals say
Interpret the signal board — where signals agree, where they diverge, and which is doing the most work right now.
### Around the corner
2–4 forward-looking points. For each: the setup, the second-order implication, the risk to it, and the data/report that would confirm or deny.
### Policy → market
The policy/regulatory items that actually move the demand or price mechanism — and how.
### On the calendar
The imminent releases worth positioning attention around, and the specific thing to watch in each.

Rules: never invent numbers or items; cite series + period for every figure; keep every markdown link; omit an empty section. This is analysis, not advice — lay out setups and risks, but do not tell anyone to buy or sell.`,
  },
};

/**
 * Generate a memo from a preset — the master query engine in report mode. Retrieves
 * across all streams scoped to the preset's window, one Sonnet call, saved as
 * YYYY-MM-DD-<edition>.md (so it lists on the homepage and renders at /brief/…).
 * @returns {{ markdown: string, filePath: string, edition: string }}
 */
export async function generateMemo(presetId, env) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in .env — get one at console.anthropic.com");
  }
  const preset = MEMO_PRESETS[presetId];
  if (!preset) {
    throw new Error(`Unknown memo preset "${presetId}" — choose one of: ${Object.keys(MEMO_PRESETS).join(", ")}`);
  }

  const watchlist = loadWatchlist();
  const timezone = watchlist.briefEditions?.timezone ?? "America/Chicago";
  const dateLabel = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());

  // Retrieve across all streams, scoped to the preset's window (memo mode).
  // Official items are triaged (verdict=relevant); news items are never triaged
  // (verdict=unscored) so we pull them by class rather than by verdict.
  const official = store.listItems({ verdict: "relevant", days: preset.scopeDays, sourceIds: sourceIdsForClass("official"), limit: 50 });
  const news = store.listItems({ days: preset.scopeDays, sourceIds: sourceIdsForClass("news"), limit: 30 });
  const compactHits = compactItems([...official, ...news]);
  const marketBlock = formatMarketSnapshot(store.marketSnapshot());
  const tracked = store.listTracked();
  const deadlines = store.upcomingDeadlines(20);

  // Daily briefs within the window (never fold memos back into memos).
  const cutoff = Date.now() - preset.scopeDays * 86400e3;
  const briefTexts = [];
  for (const b of store.listBriefs(40)) {
    if (Date.parse(b.created_at) < cutoff) continue;
    if (/-(weekly|monthly|farmer)\.md$/.test(b.path)) continue;
    const p = path.join(store.DATA_DIR, b.path);
    if (fs.existsSync(p)) briefTexts.push(`--- ${path.basename(b.path)} ---\n${fs.readFileSync(p, "utf8").slice(0, 9000)}`);
  }

  // For the education brief: inject a season-aware teaching concept (+ glossary). Auto-seed
  // the concept bank if it's empty so this works even before `seed-curriculum` is run.
  let curriculumBlock = "";
  if (preset.injectCurriculum) {
    if (store.listConcepts().length === 0) seedCurriculum();
    const concept = store.pickConcept();
    const glossary = store.getGlossary();
    curriculumBlock =
      `\n\n=== ASSIGNED TEACHING CONCEPT (explain this in "Understanding today's market") ===\n` +
      (concept ? `${concept.title}\n${concept.body}` : "(none)") +
      `\n\n=== GLOSSARY (for "Today's terms") ===\n` +
      (glossary.length ? glossary.map((g) => `- ${g.term}: ${g.definition}`).join("\n") : "(none)");
    if (concept) console.log(`   🎓 teaching concept: ${concept.id}`);
  }

  // For the Analyst Note + Market Pulse: inject the signal board + the release calendar.
  let signalsBlock = "";
  if (preset.injectSignals) {
    const sig = signalsText();
    const cal = upcomingReportsText(14);
    const pol = upcomingPolicyEventsText(120);
    const trig = triggersText();
    signalsBlock =
      `\n\n=== MARKET SIGNAL BOARD (bull/bear read for soybean price) ===\n${sig || "(no signals computed yet)"}` +
      `\n\n=== CRUSH DEMAND (capacity utilization, cause→effect with margin) ===\n${crushText() || "(not computable yet)"}` +
      `\n\n=== MEASURED LEAD-LAG vs. DAILY PRICE (read the caveats) ===\n${leadLagText()}` +
      (forecastTrackRecordText() ? `\n\n=== YOUR OWN TRACK RECORD (past calls from this tool, scored) ===\n${forecastTrackRecordText()}` : "") +
      (surpriseText() ? `\n\n=== EXPECTATIONS vs. ACTUALS (surprise is what moves price, not the level) ===\n${surpriseText()}` : "") +
      `\n\n=== UPCOMING REPORT RELEASES ===\n${cal || "(none in the next two weeks)"}` +
      `\n\n=== UPCOMING POLICY/POLITICAL DEADLINES (farm bill, appropriations, elections, sessions) ===\n${pol || "(none on the calendar)"}` +
      `\n\n=== ACTIVE MARKETING TRIGGERS (seasonal / report / positioning states) ===\n${trig || "(none active today)"}`;
    console.log(`   📊 signal board + release calendar + policy deadlines + triggers injected`);
  }

  // Per-report model: the Analyst Note runs on the deep-reasoning model (Opus +
  // adaptive thinking) — its whole job is second-order, "around the corner"
  // analysis. Every other report rides the base BRIEF_MODEL (Sonnet 5). Both are
  // overridable from .env (ANALYST_MODEL / BRIEF_MODEL) with no code change.
  const model = (preset.modelEnv && env[preset.modelEnv]) || preset.model || env.BRIEF_MODEL || "claude-sonnet-5";
  const thinkNote = preset.thinking ? ` + ${preset.thinking.type} thinking${preset.effort ? `/${preset.effort}` : ""}` : "";
  console.log(`\n📝 ${preset.label}: ${official.length + news.length} items + ${marketBlock ? "market data" : "no market data"} over the last ${preset.scopeDays}d (${model}${thinkNote})…`);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const request = {
    model,
    max_tokens: preset.maxTokens,
    system: preset.system(dateLabel),
    messages: [
      {
        role: "user",
        content:
          `Stored monitoring data for the last ${preset.scopeDays} days — write the memo per your instructions.\n\n` +
          `=== MARKET DATA (latest value, change vs prior, recent trail) ===\n${marketBlock || "(no market data stored yet)"}\n\n` +
          (marketIntelText() ? `=== MARKET INTEL FROM NEWSLETTERS (distilled from the collector inbox, cited) ===\n${marketIntelText()}\n\n` : "") +
          `=== LAWS/RULES/DECISIONS + NEWS items (JSON — one entry per government ACTION; "document" is the source's own text, "why" is a prior note, "alsoFiledAs" means the same action filed elsewhere) ===\n${JSON.stringify(compactHits, null, 1)}\n\n` +
          `=== TRACKED ITEMS (pinned) ===\n${tracked.length ? tracked.map((t) => `- ${t.title}${t.jurisdiction ? ` (${t.jurisdiction})` : ""}${t.url ? ` ${t.url}` : ""}`).join("\n") : "(none)"}\n\n` +
          `=== UPCOMING COMMENT DEADLINES ===\n${deadlines.length ? deadlines.map((d) => `- ${d.comment_deadline}: ${d.title}${d.url ? ` ${d.url}` : ""}`).join("\n") : "(none)"}\n\n` +
          `=== DAILY BRIEFS IN WINDOW ===\n${briefTexts.join("\n\n") || "(none)"}` +
          curriculumBlock +
          signalsBlock,
      },
    ],
  };
  // Deep-reasoning presets (Analyst) turn on adaptive thinking + an effort level.
  // On Opus, thinking counts against max_tokens — the preset sets a larger
  // maxTokens so the note isn't truncated. Adaptive thinking only; Opus 4.8
  // rejects the old budget_tokens knob.
  if (preset.thinking) request.thinking = preset.thinking;
  if (preset.effort) request.output_config = { effort: preset.effort };
  // Web-enabled presets (Analyst): attach the server-side web-search tool so the model can fill gaps
  // in the stored data when the read needs it. A long server tool loop can stop with stop_reason
  // "pause_turn" — re-send to continue, bounded so it can't spin (same pattern as the Ask box).
  if (preset.web && env.WEB_SEARCH !== "off") request.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }];
  let response;
  for (let turn = 0; turn < 4; turn++) {
    response = await client.messages.create(request);
    store.recordUsage(model, "memo", response.usage.input_tokens, response.usage.output_tokens);
    if (response.stop_reason !== "pause_turn") break;
    request.messages.push({ role: "assistant", content: response.content }); // echo blocks back unchanged to resume
  }
  // Web-augmented notes can span several text blocks (interleaved with search-result blocks) — join them.
  const markdown = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const filePath = saveBrief(markdown, preset.edition, timezone);

  // File the note's falsifiable claims so they can be scored later. Fail-soft: a memo is worth
  // saving even if extraction hiccups, and the ledger self-heals on the next run.
  if (preset.extractForecasts) {
    try {
      await extractForecasts(markdown, { edition: preset.edition, briefPath: path.relative(store.DATA_DIR, filePath), env });
    } catch (err) {
      console.log(`⚠️  Forecast extraction skipped: ${err.message}`);
    }
  }
  return { markdown, filePath, edition: preset.edition };
}

/** Generate + save a memo preset, then deliver it (CLI + web + scheduler entry point). */
export async function runMemo(presetId, env) {
  const { markdown, filePath, edition } = await generateMemo(presetId, env);
  console.log(`\n✅ Saved ${path.relative(store.DATA_DIR, filePath)}`);
  // On-demand memos used to stop at "saved" — nothing was ever delivered, which is why the
  // market-education brief never reached a Teams channel. Each edition can now have its own
  // recipient (its own channel address); fail-soft so a mail problem never loses the saved brief.
  try {
    let watchlist = null;
    try { watchlist = loadWatchlist(); } catch { /* delivery falls back to env alone */ }
    const to = await sendMemoEmail(markdown, edition, env, watchlist);
    if (to) console.log(`   📧 emailed to ${to}`);
    else console.log(`   📧 not emailed — no recipient configured for "${edition}" (Logs & Settings → where each report goes)`);
  } catch (err) {
    console.log(`   ⚠️ email failed: ${err.message} (the brief is still saved)`);
  }
  console.log("");
}

/** The Friday weekly memo — now a preset of the memo engine (kept for the scheduler + CLI). */
export async function runWeekly(env) {
  return runMemo("weekly", env);
}

/**
 * News daily digest — a cheap Haiku synthesis that DISTILLS the last two days of news items
 * (collector newsletters + press RSS) into themes, rather than relisting the feed. Cached in
 * kv_state (regenerated on demand). @returns {{ markdown, date, count } | null}
 */
export async function generateNewsDigest(env = process.env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in .env — get one at console.anthropic.com");
  const items = store.listItems({ days: 2, sourceIds: sourceIdsForClass("news"), limit: 70 });
  if (!items.length) return null;

  // Go beyond headlines: use the stored body (email bodies) where we have it, and for the rest
  // fetch the linked article's readable text (capped, in parallel) so the digest distills real
  // content, not just titles.
  // Items collected since 1.28.0 are grounded at ingest (enrich.js groundNewsItems), so this fetch
  // is now a BACKFILL for rows stored before that — which on the Pi is a month of history holding a
  // ~180-character teaser. The threshold is "thin", not "empty": a teaser is not article text, and
  // the old `!body.trim()` test skipped the 48-of-68 rows that had one.
  //
  // ⚠️ What it fetches is now PERSISTED (store.groundItemBody). Before, this pulled up to 14
  // articles' text into this Map, used it for one Haiku call and discarded it — paying the HTTP cost
  // every single run and keeping nothing, while retrieval and every other prompt continued to see
  // only the teaser. Same fetches, kept.
  const MAX_FETCH = 14;
  const THIN = 200; // matches enrich.js GROUNDED_MIN_CHARS
  const needFetch = items.filter((it) => (it.body || "").trim().length < THIN && it.url).slice(0, MAX_FETCH);
  const fetched = new Map();
  let healed = 0;
  await Promise.allSettled(
    needFetch.map(async (it) => {
      try {
        const { text } = await fetchDocumentText(it.url, { preserveParagraphs: true });
        if (text) {
          fetched.set(it.uid, text);
          // groundItemBody refuses to shorten, so a nav stub can't overwrite a longer teaser.
          if (store.groundItemBody(it.uid, text)) healed++;
        }
      } catch {
        /* a failed fetch just falls back to the headline */
      }
    })
  );
  if (healed) console.log(`   📰 Backfilled article text onto ${healed} older news item${healed === 1 ? "" : "s"}`);
  const enriched = items.map((it, i) => {
    // Stored email bodies are now sanitized HTML — flatten to text (keeping link URLs) for the prompt.
    const content = (emailBodyToText(it.body) || (fetched.get(it.uid) || "").replace(/\s+/g, " ")).slice(0, 1200);
    return `[${i + 1}] ${it.title}${it.url ? ` (${it.url})` : ""}${content ? `\n    ${content}` : ""}`;
  });
  const withContent = items.filter((it) => (it.body || "").trim() || fetched.has(it.uid)).length;

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.TRIAGE_MODEL || "claude-haiku-4-5";
  const resp = await client.messages.create({
    model,
    max_tokens: 1600,
    system:
      "You distill the last couple of days of ag news for the Iowa Soybean Association team. Each item below gives a headline and — where available — the email body or the article's actual text; read the CONTENT, not just the headline. DISTILL, do not relist: group into 2–4 themes, a couple of sentences each on what's actually developing and why it matters to Iowa soybeans (draw on the specifics in the content), and link out to the 1–2 most important sources per theme as markdown links. Skip noise, ads, and duplicates. Plain, tight, no preamble — start at the first theme heading.",
    messages: [{ role: "user", content: `Recent ag news (headline + content where available):\n\n${enriched.join("\n\n")}` }],
  });
  store.recordUsage(model, "news_digest", resp.usage.input_tokens, resp.usage.output_tokens);
  const markdown = resp.content.find((b) => b.type === "text")?.text?.trim() ?? "";
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  store.setState("news_digest", JSON.stringify({ date, markdown, createdAt: new Date().toISOString(), count: items.length, withContent }));
  return { markdown, date, count: items.length, withContent };
}

/** The cached news digest ({ date, markdown, createdAt, count }) or null. */
export function getCachedNewsDigest() {
  try {
    const v = store.getState("news_digest");
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

/**
 * Market-intel extraction — the newsletters/press in the collector inbox carry real market
 * intelligence (cash bids, basis, crush margins, China demand chatter, freight, policy signals) that
 * used to die on the News tab: every reasoning path (Ask box, Analyst Note, Pulse) runs items through
 * compactItems, which drops the BODY, so the model only ever saw subject lines. This distils the last
 * few days of news BODIES into a compact, cited intel block, cached in kv_state, that those paths
 * inject as context (via marketIntelText) — the intel now actually informs the model.
 * Cheap Haiku call; cached/regenerated on demand alongside the news digest. @returns {{markdown,date,count}|null}
 */
export async function extractMarketIntel(env = process.env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in .env — get one at console.anthropic.com");
  const items = store.listItems({ days: 3, sourceIds: sourceIdsForClass("news"), limit: 80 });
  const withBody = items.filter((it) => emailBodyToText(it.body).length > 80);
  if (!withBody.length) return null;

  const lines = withBody.map((it, i) => {
    const when = (it.published_at || it.first_seen_at || "").slice(0, 10);
    const content = emailBodyToText(it.body).slice(0, 1400);
    return `[${i + 1}] ${it.title}${when ? ` — ${when}` : ""}${it.url ? ` (${it.url})` : ""}\n    ${content}`;
  });

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.TRIAGE_MODEL || "claude-haiku-4-5";
  const resp = await client.messages.create({
    model,
    max_tokens: 1500,
    system:
      "You are a grain-market analyst mining the last few days of ag newsletters and press for MARKET INTELLIGENCE that bears on soybean (and corn) price — the concrete signals a trading desk cares about. From the bodies below, extract only substantive, decision-relevant facts and group them under these headings (omit a heading if it has nothing): **Price & basis**, **Demand & crush**, **Exports & trade (China)**, **Weather & crop**, **Policy & regulatory (biofuels/45Z/RFS/tariffs)**, **Other**. One tight bullet per fact, each ending with a source+date tag in parentheses. Prefer numbers, cash bids, spreads, margins, sales figures, dates. Skip opinion, ads, boilerplate, and anything already obvious. If there's little of substance, return only the headings that apply with 1–2 bullets. No preamble — start at the first heading.",
    messages: [{ role: "user", content: `News bodies (headline — date (url) + text):\n\n${lines.join("\n\n")}` }],
  });
  store.recordUsage(model, "market_intel", resp.usage.input_tokens, resp.usage.output_tokens);
  const markdown = resp.content.find((b) => b.type === "text")?.text?.trim() ?? "";
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  store.setState("market_intel", JSON.stringify({ date, markdown, createdAt: new Date().toISOString(), count: withBody.length }));
  return { markdown, date, count: withBody.length };
}

/** The cached market-intel block ({ date, markdown, createdAt, count }) or null. */
export function getCachedMarketIntel() {
  try {
    const v = store.getState("market_intel");
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

// How old a cached LLM digest may be before it stops being context and starts being misinformation.
// Set from an observed failure: the Markets page rendered a signal card written on 2026-07-08 —
// "managed-money funds… net-long 38,149 contracts (39th percentile)" and "The July WASDE, releasing
// July 10" — directly beneath a live signal board reading 130,505 contracts at the 79th percentile,
// three weeks after that WASDE. The same cached text is injected into the Analyst Note and the Ask
// box, where nothing marks it as historical, so a stale block quietly outranks fresh series data.
const CACHED_TEXT_MAX_AGE_DAYS = 4;

/** Days between an ISO timestamp and now, or Infinity if unparseable. */
function ageDays(iso) {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? Infinity : (Date.now() - t) / 86400e3;
}

/**
 * The cached market-intel markdown for prompt injection.
 *
 * Two changes from "return the markdown": it is DATED in the text (so the model can weigh it against
 * a fresher figure instead of averaging the two), and it is withheld entirely once stale, because a
 * three-week-old cash-basis quote presented as current context is worse than no context at all.
 * @returns {string} "" when absent or stale
 */
export function marketIntelText() {
  const cached = getCachedMarketIntel();
  if (!cached?.markdown) return "";
  const age = ageDays(cached.createdAt);
  if (age > CACHED_TEXT_MAX_AGE_DAYS) return "";
  return `(distilled from newsletters as of ${cached.date}${age >= 1 ? `, ${Math.floor(age)} day(s) ago — prefer any fresher figure in the market-data block` : ""})\n${cached.markdown}`;
}

/** Age in days of a cached kv_state panel, for the UI's freshness badge. Infinity if never run. */
export function cachedAgeDays(kind) {
  const get = { news_digest: getCachedNewsDigest, market_intel: getCachedMarketIntel, market_cards: getCachedMarketCards }[kind];
  return get ? ageDays(get()?.createdAt) : Infinity;
}

/** Panels older than this are collapsed and flagged in the UI rather than shown as current. */
export const STALE_PANEL_DAYS = CACHED_TEXT_MAX_AGE_DAYS;

/**
 * Signal cards — the internal output of the condition-trigger engine. Evaluates the active
 * triggers + imminent reports, then one Sonnet call writes short signal cards (what fired, what it
 * means, the directional read). Staff-facing/un-muzzled — no compliance filter (decoupled 2026-07-11).
 * Cached in kv_state. @returns {{ markdown, date, triggers } | null}
 */
export async function generateMarketCards(env = process.env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in .env — get one at console.anthropic.com");
  const now = new Date();
  const fired = evaluateTriggers(now);
  const cal = upcomingReports(7, now);
  if (!fired.length && !cal.length) return null;

  const marketBlock = formatMarketSnapshot(store.marketSnapshot());
  const system =
    `You write BeanBrief's internal SIGNAL cards for the Iowa Soybean Association demand & policy team. Turn the ACTIVE triggers below into 1–3 short signal cards; the headline card is the one with the lowest priority number (or the nearest high-impact report). Each card: what fired, what it means for soybean supply/demand/price, and the analytical read — including the likely direction and the risk to it. For a card resting on a seasonal/statistical pattern, state the sample and the caveat (e.g. "in X of the last Y years… not every year"). This is an internal analyst tool — a clear directional read is welcome; flag it as interpretation, not certainty.\n\nFormat: markdown. Begin each card with "### " and a short bold-worthy title, then 2–4 sentences grounded in the provided data (never invent a figure). No preamble, no footer.`;
  const user =
    `Today: ${now.toISOString().slice(0, 10)}.\n\n` +
    `ACTIVE TRIGGERS (ranked; lowest priority number = headline):\n${triggersText(now) || "(none)"}\n\n` +
    `IMMINENT REPORTS (next 7 days):\n${cal.slice(0, 4).map((r) => `- ${r.date} [impact ${r.impact}] ${r.name}: ${r.note}`).join("\n") || "(none)"}\n\n` +
    `MARKET DATA (for grounding any figure you cite — never invent numbers):\n${marketBlock || "(none)"}`;

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.BRIEF_MODEL || "claude-sonnet-5";
  // max_tokens headroom for Sonnet 5's default adaptive thinking (counts against the budget) + the cards.
  const synth = async (sys) => {
    const resp = await client.messages.create({ model, max_tokens: 2500, system: sys, messages: [{ role: "user", content: user }] });
    store.recordUsage(model, "cards", resp.usage.input_tokens, resp.usage.output_tokens);
    return resp.content.find((b) => b.type === "text")?.text?.trim() ?? "";
  };

  // Internal signal cards — no compliance filter (this is a staff analysis tool; compliance.js is
  // decoupled for the future farmer tool). One synthesis call; the trigger read speaks for itself.
  const markdown = await synth(system);
  if (!markdown) return null;

  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
  store.setState("market_cards", JSON.stringify({ date, markdown, createdAt: new Date().toISOString(), triggers: fired.map((f) => f.id) }));
  return { markdown, date, triggers: fired.map((f) => f.id) };
}

/** The cached market-education cards ({ date, markdown, triggers, flags }) or null. */
export function getCachedMarketCards() {
  try {
    const v = store.getState("market_cards");
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

/**
 * Storyline memory — cluster the recent relevant items into a handful of named, persistent THREADS
 * (45Z, EUDR, Summit CO2 pipeline, RD/soy-oil demand, China trade…), each with a "what changed &
 * why it matters" summary and a dated timeline. One Sonnet call. Threads are upserted by a stable
 * key and CONTINUED by name across runs (existing names fed in), so a storyline accumulates memory
 * rather than resetting. Stored in the storylines table; a homepage panel reads it. @returns {{count}|null}
 */
export async function generateStorylines(env = process.env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in .env — get one at console.anthropic.com");
  // Recent relevant items across LRD (triaged relevant) + news. News is never triaged, so pull by class.
  const official = store.listItems({ verdict: "relevant", days: 21, sourceIds: sourceIdsForClass("official"), limit: 60 });
  const news = store.listItems({ days: 21, sourceIds: sourceIdsForClass("news"), limit: 40 });
  const items = [...official, ...news];
  if (items.length < 3) return null; // too little to cluster into threads
  const lines = items.map((it, i) =>
    `[${i + 1}] ${(it.first_seen_at || "").slice(0, 10)} · ${it.title}${it.one_line ? ` — ${it.one_line}` : ""}${it.url ? ` (${it.url})` : ""}`
  );
  const existing = store.listStorylines(20).map((s) => s.name);

  const system =
    `You maintain the "storylines" for the Iowa Soybean Association's policy & market monitor — the handful of ongoing THREADS the news is really about (e.g. "45Z Clean Fuel Production Credit", "EU Deforestation Regulation (EUDR)", "Summit Carbon CO2 Pipeline", "Renewable diesel & soybean-oil demand", "China soybean trade"). Cluster the monitoring items below into 3–7 active storylines. For each, write what recently changed and why it matters to Iowa soybeans, plus a short dated timeline.\n\n` +
    `CONTINUE existing threads by their EXACT name where items fit one (list provided) — do not rename or fork a thread that already exists. Only include storylines with genuine recent activity in these items; ignore one-off noise that belongs to no thread.\n\n` +
    `Timeline most-recent-first, max 5 entries, dates from the item dates. Keys are stable kebab slugs so a thread keeps its key across updates. Use an empty string for a timeline url when the item has none.`;
  const user =
    `EXISTING STORYLINE NAMES (continue these where they fit):\n${existing.length ? existing.map((n) => `- ${n}`).join("\n") : "(none yet)"}\n\n` +
    `MONITORING ITEMS (last 21 days):\n${lines.join("\n")}`;

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.BRIEF_MODEL || "claude-sonnet-5";
  // STRUCTURED OUTPUTS replace what used to be "ask for a JSON array, then slice between the first
  // '[' and last ']' inside a try/catch". That parse failed silently — a stray sentence or a response
  // truncated mid-object produced `arr = []` and the run logged "model returned no parseable threads"
  // with no way to tell a genuinely quiet news week from a formatting accident. Schema-constrained
  // decoding removes the failure mode entirely.
  //
  // Thinking stays disabled: this is clustering, not reasoning, and on Sonnet 5 adaptive thinking is
  // on by default and counts against max_tokens — left on, it ate the budget and returned empty text.
  const resp = await client.messages.create({
    model,
    max_tokens: 4500,
    thinking: { type: "disabled" },
    output_config: { format: { type: "json_schema", schema: STORYLINE_SCHEMA } },
    system,
    messages: [{ role: "user", content: user }],
  });
  store.recordUsage(model, "storylines", resp.usage.input_tokens, resp.usage.output_tokens);
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let arr = [];
  try {
    arr = JSON.parse(text)?.storylines ?? [];
  } catch {
    arr = [];
  }
  if (!Array.isArray(arr) || !arr.length) {
    console.log("⚠️  Storylines: no threads returned (a genuinely quiet window, not a parse failure — the schema guarantees shape)");
    return null;
  }
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  let saved = 0;
  for (const s of arr) {
    if (!s || !s.name) continue;
    const key = slug(s.key || s.name);
    if (!key) continue;
    const timeline = Array.isArray(s.timeline)
      ? s.timeline
          .filter((e) => e && e.event)
          .slice(0, 5)
          .map((e) => ({
            date: String(e.date || "").slice(0, 10),
            event: String(e.event).slice(0, 240),
            url: typeof e.url === "string" && /^https?:/.test(e.url) ? e.url : "",
          }))
      : [];
    store.upsertStoryline({
      key,
      name: String(s.name).slice(0, 120),
      focus: s.focus ? String(s.focus).slice(0, 200) : null,
      summary: s.whatChanged ? String(s.whatChanged).slice(0, 800) : null,
      timeline,
      itemCount: timeline.length,
    });
    saved++;
  }
  store.pruneStorylines(30);
  store.setState("storylines_meta", JSON.stringify({ generatedAt: new Date().toISOString(), count: saved }));
  console.log(`🧵 Storylines: ${saved} active thread${saved === 1 ? "" : "s"} updated`);
  return { count: saved };
}

// --- forecast ledger: extract → store → resolve → feed back ---------------------------------
//
// The Analyst prompt already asks for a falsifiable read (setup / risk / what would confirm or kill
// it). This turns that prose into typed, dated rows so the tool can be SCORED, and then feeds the
// scored record back into later prompts. Without this the system had no memory of its own claims and
// no way to answer "has this thing been right?".
//
// Extraction uses STRUCTURED OUTPUTS (output_config.format + a json_schema) rather than asking for
// JSON in the prompt and parsing it. That matters here: generateStorylines does the latter and has to
// slice between the first "[" and last "]" inside a try/catch that silently yields zero threads on a
// malformed response. Schema-constrained decoding removes that whole failure mode.
const FORECAST_SCHEMA = {
  type: "object",
  properties: {
    forecasts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "string", description: "The falsifiable claim in one sentence, as the note stated it." },
          comparator: {
            type: "string",
            enum: ["rises", "falls", "stays_flat", "stays_above", "stays_below", "not_measurable"],
            description:
              "How the claim is settled. Use rises/falls for a DIRECTIONAL claim ('will compress', 'should widen'). Use stays_above/stays_below for a LEVEL claim ('holds above 200,000 MT', 'remains above the 90th percentile') and put the number in `threshold`. Use not_measurable when no stored series can settle it.",
          },
          threshold: { type: "number", description: "The level for stays_above / stays_below, in the series' own unit. Use 0 for every other comparator." },
          direction: { type: "string", enum: ["up", "down", "flat", "n/a"], description: "Legacy directional summary; keep consistent with `comparator` (rises→up, falls→down, stays_flat→flat, otherwise n/a)." },
          series: {
            type: "string",
            description:
              "EXACT market_series id that MEASURES THE THING BEING CLAIMED — not a driver of it, not a related indicator. If the claim is about a USDA yield print and no stored series holds that yield, return an empty string; do NOT substitute the soil-moisture series that motivated the claim. An empty string is the correct answer whenever nothing on the list directly measures the claim's subject.",
          },
          horizonDays: { type: "integer", description: "Days until the claim can be judged. Use 30 if the note implies 'the next month', 90 for 'this quarter'." },
          confirmingEvent: { type: "string", description: "The report or data release the note said would confirm or kill it." },
          confidence: { type: "string", enum: ["low", "medium", "high"], description: "How firmly the note asserted it — hedged language is low." },
        },
        required: ["claim", "comparator", "threshold", "direction", "series", "horizonDays", "confirmingEvent", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["forecasts"],
  additionalProperties: false,
};

/** Stable id for a claim so re-extracting the same brief updates instead of duplicating. */
function forecastKey(briefPath, claim) {
  const norm = String(claim).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 160);
  let h = 0;
  for (let i = 0; i < norm.length; i++) h = (h * 31 + norm.charCodeAt(i)) | 0;
  return `${briefPath ?? "adhoc"}#${(h >>> 0).toString(36)}`;
}

/**
 * Pull falsifiable claims out of a just-generated memo and file them in the ledger.
 * Cheap extraction model — this is parsing, not analysis.
 * @returns {{ stored: number } | null}
 */
export async function extractForecasts(markdown, { edition, briefPath, env = process.env } = {}) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in .env");
  if (!markdown || markdown.length < 200) return null;

  const snapshot = store.marketSnapshot();
  // Give the model the real series ids so `series` can be joined mechanically at resolution time.
  // Without this it invents plausible-looking ids and every forecast resolves as unresolvable.
  const seriesList = snapshot.map((s) => `${s.series} — ${s.label} (${s.unit})`).join("\n");

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.TRIAGE_MODEL || "claude-haiku-4-5";
  const resp = await client.messages.create({
    model,
    max_tokens: 3000,
    output_config: { format: { type: "json_schema", schema: FORECAST_SCHEMA } },
    system:
      "You extract FALSIFIABLE FORECASTS from an analyst note so they can be scored later. A forecast is a claim about which way something will move, or what a release will show, that could be checked against data at a future date. Extract at most 6, preferring the most specific and consequential. " +
      "Do NOT extract: descriptions of what already happened, definitions, general context, or advice. If the note makes no falsifiable claim, return an empty array — that is a valid and useful answer. " +
      "TWO RULES THAT MATTER MOST, both learned from mis-scored forecasts:\n" +
      "1. `series` must MEASURE THE CLAIM'S SUBJECT, not its cause. A claim that dry soil will produce a below-trend YIELD PRINT is a claim about yield — if no stored series holds that yield, return an empty string. Attaching the soil-moisture series makes the claim resolve on whether soil dried out, which it will anyway, recording a false hit on a yield call.\n" +
      "2. Choose `comparator` by how the claim is actually worded. 'holds above 200,000 MT' and 'remains above the 90th percentile' are LEVEL claims → stays_above with the number in `threshold`. Only use rises/falls when the claim is genuinely about direction of travel. Coercing a level claim into a direction gets it scored against the wrong test.\n" +
      "Be conservative about `confidence`: hedged language ('may', 'could', 'risks') is low.",
    messages: [
      {
        role: "user",
        content: `AVAILABLE MARKET SERIES (use exact ids for the \`series\` field):\n${seriesList}\n\n=== ANALYST NOTE (${edition}) ===\n${markdown.slice(0, 20000)}`,
      },
    ],
  });
  store.recordUsage(model, "forecast_extract", resp.usage.input_tokens, resp.usage.output_tokens);

  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.log("⚠️  Forecast extraction: response was not valid JSON despite the schema — skipping");
    return null;
  }
  const list = Array.isArray(parsed?.forecasts) ? parsed.forecasts : [];
  const bySeries = new Map(snapshot.map((s) => [s.series, s]));
  const createdAt = new Date().toISOString();
  let stored = 0;
  for (const f of list) {
    if (!f?.claim) continue;
    const seriesId = f.series && bySeries.has(f.series) ? f.series : null;
    const base = seriesId ? bySeries.get(seriesId) : null;
    const horizon = Number.isFinite(f.horizonDays) && f.horizonDays > 0 ? Math.min(f.horizonDays, 365) : 30;
    // A stays_above/stays_below claim without a usable threshold can't be judged — record it as
    // not_measurable rather than silently falling back to a direction the claim never asserted.
    let comparator = f.comparator ?? null;
    const isLevel = comparator === "stays_above" || comparator === "stays_below";
    if (isLevel && !Number.isFinite(f.threshold)) comparator = "not_measurable";
    if (!seriesId) comparator = "not_measurable";
    store.upsertForecast({
      dedupeKey: forecastKey(briefPath, f.claim),
      briefPath,
      edition,
      createdAt,
      claim: String(f.claim).slice(0, 600),
      direction: f.direction ?? null,
      comparator,
      threshold: isLevel && Number.isFinite(f.threshold) ? f.threshold : null,
      series: seriesId,
      horizonDays: horizon,
      resolveBy: new Date(Date.now() + horizon * 864e5).toISOString().slice(0, 10),
      confirmingEvent: f.confirmingEvent ? String(f.confirmingEvent).slice(0, 300) : null,
      confidence: f.confidence ?? null,
      // Baseline is captured NOW so the resolver compares against the state of the world when the
      // claim was made, not against whatever the series looked like at resolution time.
      baselineValue: base ? base.latest.value : null,
      baselinePeriod: base ? base.latest.period : null,
    });
    stored++;
  }
  if (stored) console.log(`🔮 Forecast ledger: ${stored} claim${stored === 1 ? "" : "s"} filed from ${edition}`);
  return { stored };
}

/**
 * Judge every pending forecast whose resolve_by has passed.
 *
 * A claim is judged ONLY when it named a stored series and that series has moved on since the
 * baseline; anything else is marked `unresolvable` and excluded from the hit rate rather than
 * silently counted as a miss.
 *
 * SCORING IS THREE-WAY, and that detail is what makes the hit rate honest. The flat band is half a
 * standard deviation of historical moves over the same horizon, so "flat" means flat relative to how
 * far this series normally travels in that many periods rather than an arbitrary percentage. Then:
 *   - directional claim, moved that way beyond the band       → hit
 *   - directional claim, moved the OPPOSITE way beyond it     → miss
 *   - directional claim, stayed inside the band               → INCONCLUSIVE, not counted
 *   - flat claim                                              → hit inside the band, miss outside
 * The inconclusive bucket exists because the first version scored a correct call as a miss: price
 * rose 1154→1188.5 (+3%) against a ±51¢ band, so a right-but-modest "up" call was punished. Being
 * directionally right on a quiet market is not a forecasting error, and folding those into "miss"
 * would understate the tool's accuracy and teach the model to hedge for the wrong reason.
 * @returns {{ judged, hit, miss, inconclusive, unresolvable }}
 */
export function resolveForecasts() {
  const due = store.forecastsDueForResolution();
  let hit = 0, miss = 0, unresolvable = 0, inconclusive = 0;
  for (const f of due) {
    const levelClaim = (f.comparator === "stays_above" || f.comparator === "stays_below") && f.threshold != null;
    const directionalClaim = f.comparator
      ? ["rises", "falls", "stays_flat"].includes(f.comparator)
      : f.direction && f.direction !== "n/a"; // pre-comparator rows fall back to `direction`
    if (!f.series || f.comparator === "not_measurable" || (!levelClaim && !directionalClaim) || (directionalClaim && f.baseline_value == null)) {
      store.resolveForecast(f.id, { outcome: "unresolvable", note: "No stored series measures this claim's subject, so it can't be settled mechanically." });
      unresolvable++;
      continue;
    }
    let pts = [];
    try {
      pts = store.getSeries(f.series);
    } catch {
      pts = [];
    }
    const after = pts.filter((p) => p.period > (f.baseline_period ?? ""));
    if (!after.length) {
      store.resolveForecast(f.id, { outcome: "unresolvable", note: `No new ${f.series} observations since ${f.baseline_period}.` });
      unresolvable++;
      continue;
    }
    const observed = after[after.length - 1];

    // LEVEL claims ("holds above 200,000 MT", "stays above the 90th percentile") are settled against
    // the threshold, never against the baseline. This branch exists because the first live batch had
    // four such claims and every one of them was being judged as if it were directional — a fall from
    // 302k to 250k would have scored MISS against a claim of "holds above 200k" that in fact held.
    if (levelClaim) {
      const held = f.comparator === "stays_above" ? observed.value >= f.threshold : observed.value <= f.threshold;
      if (held) hit++; else miss++;
      store.resolveForecast(f.id, {
        outcome: held ? "hit" : "miss",
        observedValue: observed.value,
        observedPeriod: observed.period,
        note: `Claimed ${f.comparator.replace("_", " ")} ${f.threshold}; ${f.series} was ${observed.value} on ${observed.period}.`,
      });
      continue;
    }

    const move = observed.value - f.baseline_value;

    // Threshold: half a standard deviation of historical h-period moves, h = however many
    // observations of this series fall inside the forecast horizon.
    const baseIdx = pts.findIndex((p) => p.period === f.baseline_period);
    const h = Math.max(1, baseIdx >= 0 ? after.length : 1);
    const hMoves = [];
    for (let i = h; i < pts.length; i++) hMoves.push(pts[i].value - pts[i - h].value);
    let thresh = 0;
    if (hMoves.length >= 8) {
      const mu = hMoves.reduce((a, b) => a + b, 0) / hMoves.length;
      thresh = 0.5 * Math.sqrt(hMoves.reduce((s, v) => s + (v - mu) ** 2, 0) / hMoves.length);
    }
    const actual = move > thresh ? "up" : move < -thresh ? "down" : "flat";
    // Prefer the comparator; fall back to `direction` for rows filed before comparator existed.
    const claimed = f.comparator === "rises" ? "up" : f.comparator === "falls" ? "down" : f.comparator === "stays_flat" ? "flat" : f.direction;
    let outcome;
    if (claimed === "flat") {
      outcome = actual === "flat" ? "hit" : "miss";
    } else if (actual === "flat") {
      // Directionally right or wrong is unknowable when the series barely moved — don't guess.
      outcome = "inconclusive";
    } else {
      outcome = actual === claimed ? "hit" : "miss";
    }
    if (outcome === "hit") hit++;
    else if (outcome === "miss") miss++;
    else inconclusive++;
    store.resolveForecast(f.id, {
      outcome,
      observedValue: observed.value,
      observedPeriod: observed.period,
      note:
        `Claimed ${claimed}; ${f.series} went ${actual} (${f.baseline_value} → ${observed.value}, move ${move >= 0 ? "+" : ""}${move.toFixed(2)} vs flat-band ±${thresh.toFixed(2)}).` +
        (outcome === "inconclusive" ? " Inside the band, so the direction call is not judgeable — excluded from the hit rate." : ""),
    });
  }
  const judged = hit + miss;
  if (due.length) console.log(`🔮 Forecast ledger: resolved ${due.length} — ${hit} hit / ${miss} miss / ${inconclusive} inconclusive / ${unresolvable} unresolvable`);
  return { judged, hit, miss, inconclusive, unresolvable };
}

/**
 * The track record, for injection into later prompts. This is the loop closing: the model sees what
 * it previously claimed and how those claims turned out, so it can calibrate instead of starting
 * fresh every time. Says so explicitly when the sample is too small to mean anything.
 */
export function forecastTrackRecordText(limit = 10) {
  const card = store.forecastScorecard();
  const resolved = [...store.listForecasts({ outcome: "hit", limit }), ...store.listForecasts({ outcome: "miss", limit })]
    .sort((a, b) => String(b.resolved_at).localeCompare(String(a.resolved_at)))
    .slice(0, limit);
  if (!card.judged && !card.pending) return "";
  const head =
    card.judged >= 5
      ? `Track record of this tool's own past calls: ${card.hit} hit / ${card.miss} miss on ${card.judged} judged forecasts (${Math.round((card.hitRate ?? 0) * 100)}%). ${card.pending} still open.`
      : `Track record: only ${card.judged} forecast${card.judged === 1 ? "" : "s"} judged so far (${card.pending} still open) — TOO FEW to infer any skill. Do not cite a hit rate; the ledger is still filling.`;
  const lines = resolved.map(
    (r) => `- [${r.outcome.toUpperCase()}] (${String(r.created_at).slice(0, 10)}, conf ${r.confidence ?? "?"}) ${r.claim}${r.resolution_note ? ` → ${r.resolution_note}` : ""}`
  );
  const conf = Object.entries(card.byConfidence)
    .map(([c, v]) => `${c}: ${v.hit}/${v.hit + v.miss}`)
    .join("; ");
  return `${head}${conf ? `\nBy stated confidence — ${conf}.` : ""}${lines.length ? `\nMost recently judged:\n${lines.join("\n")}` : ""}\nUse this to calibrate: if past high-confidence calls missed, hedge harder this time.`;
}

// --- report expectations → surprise ----------------------------------------------------------
const EXPECTATION_SCHEMA = {
  type: "object",
  properties: {
    expectations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          report: { type: "string", description: 'Report name plus period, e.g. "WASDE 2026-08" or "Grain Stocks 2026-09".' },
          reportDate: { type: "string", description: "Expected release date as YYYY-MM-DD, or empty string if not stated." },
          item: { type: "string", description: 'What is being estimated, e.g. "U.S. soybean ending stocks".' },
          series: { type: "string", description: "EXACT market_series id from the provided list that will hold the actual, or empty string." },
          unit: { type: "string" },
          estLow: { type: "number", description: "Low end of the analyst range. Repeat estAvg if only an average is given." },
          estAvg: { type: "number", description: "Average / consensus estimate." },
          estHigh: { type: "number", description: "High end of the range. Repeat estAvg if only an average is given." },
          source: { type: "string", description: "Publication the estimate came from." },
        },
        required: ["report", "reportDate", "item", "series", "unit", "estLow", "estAvg", "estHigh", "source"],
        additionalProperties: false,
      },
    },
  },
  required: ["expectations"],
  additionalProperties: false,
};

/**
 * Mine recent news bodies for PRE-REPORT trade estimates and file them so the next release can be
 * scored as a surprise rather than just a number.
 *
 * Returns `{ stored: 0, scanned: n }` when the inbox carries no estimate language — which, on the
 * evidence available locally, is the likely case. That is reported plainly rather than dressed up:
 * see the sourcing caveat on report_expectations in store.js.
 */
export async function extractExpectations(env = process.env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in .env");
  const items = store.listItems({ days: 10, sourceIds: sourceIdsForClass("news"), limit: 80 });
  const withBody = items.filter((it) => emailBodyToText(it.body).length > 120);
  if (!withBody.length) return { stored: 0, scanned: 0 };

  const snapshot = store.marketSnapshot();
  const seriesList = snapshot.map((s) => `${s.series} — ${s.label} (${s.unit})`).join("\n");
  const lines = withBody.map((it, i) => {
    const when = (it.published_at || it.first_seen_at || "").slice(0, 10);
    return `[${i + 1}] ${it.title}${when ? ` — ${when}` : ""}\n    ${emailBodyToText(it.body).slice(0, 1600)}`;
  });

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.TRIAGE_MODEL || "claude-haiku-4-5";
  const resp = await client.messages.create({
    model,
    max_tokens: 2500,
    output_config: { format: { type: "json_schema", schema: EXPECTATION_SCHEMA } },
    system:
      "You extract PRE-REPORT TRADE ESTIMATES from ag newsletters — the analyst survey / consensus figures published BEFORE a USDA release (WASDE, Grain Stocks, Acreage, Crop Production, NOPA crush). " +
      "Extract ONLY forward-looking estimates of a number not yet published. Do NOT extract: actual reported figures, last month's number, a prior USDA estimate being revised, or a general opinion with no figure. " +
      "If a range is given use estLow/estHigh; if only an average is given, repeat it in all three fields. Return an empty array if there are no genuine pre-report estimates — that is a valid and common answer, and a wrong extraction is far worse than none.",
    messages: [{ role: "user", content: `AVAILABLE MARKET SERIES (exact ids for \`series\`):\n${seriesList}\n\n=== RECENT NEWS BODIES ===\n${lines.join("\n\n")}` }],
  });
  store.recordUsage(model, "expectations", resp.usage.input_tokens, resp.usage.output_tokens);

  let parsed;
  try {
    parsed = JSON.parse(resp.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
  } catch {
    return { stored: 0, scanned: withBody.length };
  }
  const bySeries = new Set(snapshot.map((s) => s.series));
  let stored = 0;
  for (const e of parsed?.expectations ?? []) {
    if (!e?.report || !e?.item || !Number.isFinite(e.estAvg)) continue;
    store.upsertExpectation({
      dedupeKey: `${e.report}|${e.item}|${e.source || "?"}`.toLowerCase().slice(0, 200),
      report: String(e.report).slice(0, 120),
      reportDate: /^\d{4}-\d{2}-\d{2}$/.test(e.reportDate) ? e.reportDate : null,
      item: String(e.item).slice(0, 200),
      series: e.series && bySeries.has(e.series) ? e.series : null,
      unit: e.unit ? String(e.unit).slice(0, 40) : null,
      estLow: Number.isFinite(e.estLow) ? e.estLow : null,
      estAvg: e.estAvg,
      estHigh: Number.isFinite(e.estHigh) ? e.estHigh : null,
      source: e.source ? String(e.source).slice(0, 120) : null,
      sourceDate: new Date().toISOString().slice(0, 10),
    });
    stored++;
  }
  console.log(
    stored
      ? `🎯 Expectations: ${stored} pre-report estimate${stored === 1 ? "" : "s"} filed from ${withBody.length} news bodies`
      : `🎯 Expectations: no pre-report trade estimates found in ${withBody.length} news bodies (the inbox may simply not carry them — see the sourcing caveat in store.js)`
  );
  return { stored, scanned: withBody.length };
}

/**
 * Join open expectations to their actual once the series publishes, and score the surprise.
 *
 * `surpriseSigma` scales the miss by the analyst range (high − low), which is the market's own
 * measure of how uncertain the number was: landing 2 units above consensus is a shock when the whole
 * range was 1 unit wide and a non-event when it was 10. Falls back to the series' historical move
 * volatility when only a point estimate was published, and reports nothing when it can do neither
 * rather than inventing a denominator.
 * @returns {{ settled: number }}
 */
export function computeSurprises() {
  const open = store.openExpectations();
  let settled = 0;
  for (const e of open) {
    if (!e.series || e.est_avg == null) continue;
    let pts = [];
    try {
      pts = store.getSeries(e.series);
    } catch {
      continue;
    }
    if (!pts.length) continue;
    // The actual must postdate the estimate — otherwise we'd "settle" against a figure that was
    // already public when the estimate was made, which measures nothing.
    //
    // ⚠️ COMPARE PERIODS AS DATES, NOT STRINGS. Series periods come in three granularities ("2026",
    // "2026-07", "2026-07-30") and a raw string compare silently breaks across them: a monthly
    // series' "2026-07" sorts BELOW a "2026-07-01" cutoff because it's a prefix, so the July WASDE
    // was filtered out of its own July release window and nothing ever settled. Pad to a full date
    // first — for a monthly series the release period and the cutoff month must compare equal.
    const asDate = (p) => {
      const s = String(p);
      const full = s.length === 4 ? `${s}-01-01` : s.length === 7 ? `${s}-01` : s;
      const t = Date.parse(full);
      return Number.isNaN(t) ? null : t;
    };
    const cutoffMs = asDate(e.report_date || e.source_date || e.created_at.slice(0, 10));
    const after = cutoffMs == null ? pts.slice() : pts.filter((p) => { const t = asDate(p.period); return t != null && t >= cutoffMs; });
    if (!after.length) continue;
    const actual = after[0];
    const surprise = actual.value - e.est_avg;

    let denom = null;
    if (e.est_high != null && e.est_low != null && e.est_high > e.est_low) denom = (e.est_high - e.est_low) / 2;
    if (!denom) {
      const diffs = [];
      for (let i = 1; i < pts.length; i++) diffs.push(pts[i].value - pts[i - 1].value);
      if (diffs.length >= 8) {
        const mu = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        const sd = Math.sqrt(diffs.reduce((s, v) => s + (v - mu) ** 2, 0) / diffs.length);
        if (sd > 0) denom = sd;
      }
    }
    store.settleExpectation(e.id, {
      actualValue: actual.value,
      actualPeriod: actual.period,
      surprise,
      surpriseSigma: denom ? surprise / denom : null,
    });
    settled++;
  }
  if (settled) console.log(`🎯 Expectations: ${settled} release${settled === 1 ? "" : "s"} scored against consensus`);
  return { settled };
}

/** Labelled surprise history + open consensus, for the Analyst / Ask / Education prompts. */
export function surpriseText(limit = 6) {
  const settled = store.listExpectations({ settledOnly: true, limit });
  const open = store.openExpectations().filter((e) => e.est_avg != null);
  if (!settled.length && !open.length) return "";
  const parts = [];
  if (open.length) {
    parts.push(
      "AHEAD OF THE NEXT RELEASE — consensus on file (the number to beat, not a forecast):\n" +
        open
          .slice(0, 6)
          .map((e) => {
            const n = (v) => (v == null ? "?" : String(Math.round(v * 1000) / 1000));
            return `- ${e.report} · ${e.item}: consensus ${n(e.est_avg)}${e.est_low != null && e.est_high != null ? ` (range ${n(e.est_low)}–${n(e.est_high)})` : ""} ${e.unit ?? ""}${e.source ? ` [${e.source}]` : ""}`;
          })
          .join("\n")
    );
  }
  if (settled.length) {
    parts.push(
      "PAST RELEASES SCORED AS SURPRISES (actual vs. what the trade expected — this is what actually moves price):\n" +
        settled
          .map((e) => {
            const dir = e.surprise > 0 ? "above" : e.surprise < 0 ? "below" : "on";
            const sig = e.surprise_sigma != null ? ` (${Math.abs(e.surprise_sigma).toFixed(1)}× the analyst range)` : "";
            // Round for the prompt — raw floats like 6.8584070796460175 are noise that costs tokens
            // and invites the model to quote spurious precision back at the reader.
            const n = (v) => (v == null ? "?" : String(Math.round(v * 1000) / 1000));
            return `- ${e.report} · ${e.item}: actual ${n(e.actual_value)} vs consensus ${n(e.est_avg)} → ${Math.abs(e.surprise).toFixed(2)} ${e.unit ?? ""} ${dir} expectations${sig}`;
          })
          .join("\n")
    );
  }
  return parts.join("\n\n");
}

const STORYLINE_SCHEMA = {
  type: "object",
  properties: {
    storylines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", description: "Stable kebab-case slug; reuse the existing thread's slug when continuing one." },
          name: { type: "string", description: "Thread name. Match an existing name EXACTLY when continuing that thread." },
          focus: { type: "string", description: "One line: what this thread is about." },
          whatChanged: { type: "string", description: "2-3 sentences: what developed recently and why it matters to Iowa soybeans." },
          timeline: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: { type: "string", description: "YYYY-MM-DD, taken from the item date." },
                event: { type: "string" },
                url: { type: "string", description: "Source url, or empty string when the item has none." },
              },
              required: ["date", "event", "url"],
              additionalProperties: false,
            },
          },
        },
        required: ["key", "name", "focus", "whatChanged", "timeline"],
        additionalProperties: false,
      },
    },
  },
  required: ["storylines"],
  additionalProperties: false,
};

/** Metadata about the last storyline generation ({ generatedAt, count }) or null. */
export function getStorylinesMeta() {
  try {
    const v = store.getState("storylines_meta");
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

export async function runAudit() {
  const { sourceCounts, lastRuns, monthUsage, briefCount } = store.getAuditData();

  console.log("\n📊 polibrief audit\n");
  console.log("Per-source items seen:");
  if (sourceCounts.length === 0) console.log("   (none yet — run the pipeline first)");
  for (const row of sourceCounts) {
    console.log(`   ${row.source_id.padEnd(18)} ${String(row.total).padStart(5)} seen, ${String(row.relevant ?? 0).padStart(4)} relevant`);
  }

  console.log("\nLast successful fetch:");
  if (lastRuns.length === 0) console.log("   (no completed runs yet)");
  for (const row of lastRuns) {
    console.log(`   ${row.source_id.padEnd(18)} ${row.last_success_at}`);
  }

  console.log(`\nBriefs saved: ${briefCount}`);

  console.log("\nAnthropic usage this month:");
  if (monthUsage.length === 0) console.log("   (no Anthropic calls yet)");
  let totalCost = 0;
  for (const row of monthUsage) {
    const price = PRICES[row.model] ?? { input: 3.0, output: 15.0 };
    const cost = (row.input_tokens / 1e6) * price.input + (row.output_tokens / 1e6) * price.output;
    totalCost += cost;
    console.log(
      `   ${row.model.padEnd(20)} ${String(row.calls).padStart(4)} calls, ` +
        `${String(row.input_tokens).padStart(9)} in / ${String(row.output_tokens).padStart(8)} out tokens ≈ $${cost.toFixed(2)}`
    );
  }
  if (monthUsage.length > 0) console.log(`   ${"".padEnd(20)} estimated month-to-date total ≈ $${totalCost.toFixed(2)}`);
  console.log();
}
