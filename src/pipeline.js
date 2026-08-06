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
import { signalsText, computeSignals } from "./signals.js";
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
import { buildPackets } from "./packets.js";
import { buildTheses, renderTheses } from "./thesis.js";
import { challengeTheses, applyChallenges, renderWeakness } from "./challenger.js";
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
// After this many consecutive delivery failures, commit anyway rather than re-detecting the same
// changes forever. A week of broken SMTP would otherwise hold the snapshot still and then emit a storm
// of accumulated alerts on recovery; bounded loss beats an unbounded storm, and the abandoned titles
// are logged so the loss is visible rather than silent.
const ALERT_FAILURE_LIMIT = 3;
const ALERT_FAILURE_KEY = "alerts:consecutive_delivery_failures";

/**
 * Detect material market changes → the "what changed" alert feed, then commit only once delivery has
 * been resolved. Returns the new alerts.
 *
 * ⚠️ TWO STRUCTURAL BUGS FIXED HERE (1.29.0). Together they meant alerts had almost certainly never
 * been delivered, and that a failed delivery lost the alert permanently.
 *
 * 1. THE OPT-IN WAS UNREACHABLE. The email gate read `output.alertEmail`, but `output` was a parameter
 *    the caller had to remember to pass — and both CLI entry points (`market-refresh`, `alerts-check`)
 *    call this with one argument, so `output` was null and the gate could not fire. The one caller that
 *    did pass it (`runFullPipeline`) read a key that was ABSENT from watchlist.json. A gate that
 *    depends on every caller remembering is a gate that eventually never fires, so this now resolves
 *    the setting itself.
 * 2. THE SNAPSHOT ADVANCED BEFORE DELIVERY. See `detectChanges` and `store.commitAlerts`.
 */
export async function runAlertsCheck(env = process.env, output = null) {
  // Resolve the setting ourselves when the caller didn't supply it — removes the requirement to
  // remember, rather than fixing the two call sites and trusting the next one.
  let out = output;
  if (out == null) {
    try {
      out = loadWatchlist().output ?? {};
    } catch {
      out = {};
    }
  }

  let detected;
  try {
    detected = detectChanges({ commit: false }); // pure: writes nothing until we commit below
  } catch (err) {
    console.log(`⚠️  Change detection skipped: ${err.message}`);
    return [];
  }
  const { changes, pendingState } = detected;

  if (!changes.length) {
    // Nothing moved, but the comparison snapshot must still track the new values or the next run
    // compares against stale ones.
    store.commitAlerts([], pendingState);
    store.setState(ALERT_FAILURE_KEY, "0");
    return [];
  }

  console.log(`🔔 ${changes.length} market change alert${changes.length === 1 ? "" : "s"}: ${changes.slice(0, 4).map((c) => c.title).join("; ")}${changes.length > 4 ? "…" : ""}`);

  // Only a THROWN delivery error blocks the commit. "Opted out" and "SMTP not configured" are
  // permanent states, not transient failures — blocking on those would mean a Pi without SMTP never
  // advances its snapshot and re-detects the same changes on every run forever. The alerts still reach
  // the in-app "what changed" feed either way, which is the primary surface.
  let deliveryFailed = false;
  if (out?.alertEmail === true) {
    try {
      if (await sendAlertEmail(changes, env)) console.log("   📧 alert digest emailed");
      else console.log("   ℹ️  alert email is on but SMTP isn't configured — alerts saved to the feed only");
    } catch (err) {
      deliveryFailed = true;
      console.log(`⚠️  Alert email failed: ${err.message}`);
    }
  }

  const failures = Number(store.getState(ALERT_FAILURE_KEY) ?? 0) || 0;
  if (deliveryFailed && failures + 1 < ALERT_FAILURE_LIMIT) {
    store.setState(ALERT_FAILURE_KEY, String(failures + 1));
    console.log(
      `   ⏸️  Alert snapshot held back (delivery failure ${failures + 1}/${ALERT_FAILURE_LIMIT}) — these changes will be re-detected next check, not lost.`
    );
    return changes;
  }
  if (deliveryFailed) {
    console.log(
      `   ⚠️  Advancing the alert snapshot after ${ALERT_FAILURE_LIMIT} failed deliveries. These changes will NOT be re-detected: ${changes.map((c) => c.title).join("; ")}`
    );
  }
  store.commitAlerts(changes, pendingState);
  store.setState(ALERT_FAILURE_KEY, "0");
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
  // Same shape for feedback_at, so existing 👍/👎 history keeps its current ordering while new
  // feedback gets a true timestamp (see store.backfillFeedbackAt for why the seeded value is
  // deliberately approximate).
  try {
    store.backfillFeedbackAt();
  } catch (err) {
    console.log(`⚠️  Feedback-timestamp backfill skipped: ${err.message}`);
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
    // ⚠️ AM EDITION ONLY, AND THIS IS WHAT PAYS FOR THE EVIDENCE PACKETS BELOW. Measured from
    // `token_usage`: storylines is the single largest line item in the whole tool — ~10.6k in / 2.9k
    // out per call on Sonnet 5 ≈ $0.076, and it was running on BOTH daily editions ≈ $4.56/mo. A
    // 21-day clustering window does not meaningfully change between 06:30 and 16:30, so the PM call
    // was re-deriving the same threads for the same money. Halving it funds packets outright.
    // The homepage "Update storylines" button and the `storylines` CLI still run on demand.
    if (edition !== "pm") {
      try {
        await generateStorylines(env);
      } catch (err) {
        console.log(`⚠️  Storylines skipped: ${err.message}`);
      }
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
  // Opus 5 is priced identically to Opus 4.8, so ANALYST_MODEL can move between them as a one-line
  // .env change with no cost difference. Listed explicitly because an unlisted model falls back to
  // the Sonnet default below, which would under-report Opus spend by 40%.
  "claude-opus-5": { input: 5.0, output: 25.0 },
};

// Prompt-cache billing multipliers, applied to the model's INPUT rate. A 5-minute-TTL write costs
// 1.25x and a read 0.1x, so a cached prefix pays for itself on the second request that hits it.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

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

  // 3a-bis. EVIDENCE PACKETS for the must_read actions (see packets.js).
  //
  // ⚠️ POSITION IS LOAD-BEARING, IN BOTH DIRECTIONS, AND A TEST LOCKS IT.
  //   - It must come AFTER triage, because eligibility is `triage_tier = 'must_read'` — run it earlier
  //     and there are no tiers yet, so nothing qualifies and the feature silently does nothing.
  //   - It must come AFTER enrichment (:362) and news grounding (:382), because packets read
  //     `seen_items.body` and never fetch. Run it before those and every news packet is built from a
  //     ~180-character feed teaser, i.e. correctly but uselessly marked "thin".
  // Fail-soft: a packet is an optimisation of context, never a precondition for the brief.
  try {
    await buildPackets({ env });
  } catch (err) {
    console.log(`⚠️  Evidence packets skipped: ${err.message}`);
  }

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

// Pinned items in a prompt: capped, but the true total is ALWAYS stated.
//
// ⚠️ This block was the one genuinely unbounded thing in any prompt this tool builds — `listTracked()`
// had no LIMIT and neither call site sliced it. Invisible at two pins; at a few hundred it would have
// crowded out the retrieved items and market data it sits beside. Pins are also the only
// USER-CURATED signal in the context, which makes a silent truncation here the worst kind: the block
// reads as "these are all your pinned items" whether or not it is.
const TRACKED_PROMPT_LIMIT = 25;

function trackedBlock() {
  const total = store.trackedCount();
  const rows = store.listTracked(TRACKED_PROMPT_LIMIT);
  if (!rows.length) return "(none)";
  const lines = rows.map((t) => `- ${t.title}${t.jurisdiction ? ` (${t.jurisdiction})` : ""}${t.url ? ` ${t.url}` : ""}`);
  if (total > rows.length) lines.push(`- (+${total - rows.length} more pinned item${total - rows.length === 1 ? "" : "s"} not listed here)`);
  return lines.join("\n");
}

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
  const groups = groupByEvent(rows);
  // One query for the whole prompt's worth of items rather than one per row.
  const packets = store.packetsFor(groups.map(({ members }) => pickLead(members).event_key));
  return groups.map(({ members }) => {
    const h = pickLead(members);
    const doc = String(h.body ?? "").trim();
    const others = members.filter((m) => m.uid !== h.uid);
    const p = packets.get(h.event_key);
    // A THIN packet carries no more information than the title, so it is not worth prompt space — fall
    // back to the document excerpt (which for a thin item is the teaser, correctly labelled below).
    const usePacket = p && p.sufficiency !== "thin" && p.packet;
    const entry = {
      // `uid` is what a thesis cites as `item:<uid>` (thesis.js resolveEvidence). Without it the
      // model can only cite items by title, which cannot be validated and so cannot be grounded.
      uid: h.uid,
      eventKey: h.event_key ?? undefined,
      title: h.title,
      url: h.url,
      source: h.source_id,
      jurisdiction: h.jurisdiction,
      why: h.one_line,
      verdict: h.triage_verdict,
      priority: h.triage_tier ?? undefined,
      seen: (h.first_seen_at || "").slice(0, 10),
      deadline: h.comment_deadline ? String(h.comment_deadline).slice(0, 10) : undefined,
      // What this entry's substance actually rests on, so a consumer never has to guess whether it is
      // reading extracted evidence, raw document text, or nothing at all.
      evidenceBasis: usePacket ? "packet" : doc.length >= 200 ? "document" : "title_only",
      // Same action, other filings. Named this way on purpose: "alsoFiledAs" reads as one thing in
      // several places, where a bare array of titles would read as several things.
      alsoFiledAs: others.length ? others.slice(0, 6).map((m) => `${m.source_id}: ${m.url || m.uid}`) : undefined,
    };
    if (usePacket) {
      // The packet REPLACES the document excerpt — sending both would pay twice for the same text.
      const pk = p.packet;
      entry.packet = {
        sufficiency: p.sufficiency,
        whatHappened: pk.what_happened,
        claims: pk.claims,
        actionsRequired: pk.actions_required,
        dates: pk.dates,
        quantities: pk.quantities,
        soyMechanisms: pk.soy_mechanisms,
        evidence: pk.evidence, // every quote here was verified as a verbatim substring of the source
        unknowns: pk.unknowns,
        notInDocument: pk.not_in_document,
      };
    } else if (doc) {
      // The document's own words, explicitly labelled as such so the model can tell sourced text
      // from the triager's interpretation in `why`.
      entry.document = doc.slice(0, CONTEXT_BODY_CHARS) + (doc.length > CONTEXT_BODY_CHARS ? " […]" : "");
    }
    return entry;
  });
}

/**
 * The master query engine: answer a question by retrieving across EVERY pipeline —
 * Laws/Rules/Decisions + News items, the demand-side MARKET timeseries, tracked items,
 * upcoming comment deadlines, and recent briefs — then one Sonnet call to synthesize
 * with citations. Shared by the CLI (`query`) and the homepage "Ask the Bean Brief" box.
 * @returns {{ answer: string, hits: object[] }}
 */
export async function answerQuery(question, env, source = "ui") {
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

  // 3. Upcoming comment deadlines. (Pinned items are read inside trackedBlock(), which caps the list
  //    and states the true total.)
  const deadlines = store.upcomingDeadlines(20);

  // 4. Most recent few briefs as narrative context.
  const briefTexts = [];
  for (const b of store.listBriefs(4)) {
    const p = path.join(store.DATA_DIR, b.path);
    if (fs.existsSync(p)) briefTexts.push(`--- Brief ${b.path} ---\n${fs.readFileSync(p, "utf8").slice(0, 6000)}`);
  }

  if (compactHits.length === 0 && !marketBlock && briefTexts.length === 0) {
    const answer = "Nothing stored yet matches. Run the pipeline a few times first.";
    // Logged too: an ask that couldn't even be attempted is the strongest possible evidence of a gap,
    // and it's the one case that never reaches the model at all.
    try {
      store.logAsk({ question, source, hits: 0, webSearches: 0, answer, unanswered: true });
    } catch {
      /* instrumentation must never break an answer */
    }
    return { answer, hits: [] };
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.BRIEF_MODEL || "claude-sonnet-5";
  const system =
    "You are the senior market-and-policy analyst for an Iowa Soybean Association professional whose remit is BOTH policy and demand/markets. This is an INTERNAL analysis tool for staff — give a sharp, direct answer, not a hedged briefing. Draw on the stored monitoring data provided below, which spans three streams: (1) LAWS/RULES/DECISIONS + NEWS items, (2) MARKET DATA (soybean price, crush, stocks, biofuel feedstock share, basis, fund positioning, exports, barge freight, crop condition, weather), and (3) recent BRIEFS, plus tracked items and comment deadlines. The market data carries trend context per series — change vs. prior, year-over-year, the historical range with the latest value's percentile, and a seasonal read (vs. the same month across years). USE that context to explain trends and whether a value is seasonally normal or unusual, not just the latest number. Synthesize across streams — connect policy/trade developments to the market MECHANISM and the numbers, go second-order, and where the data supports it give a directional read: the most likely interpretation, the risk to it, and the report or data that would confirm or kill it. Distinguish FACT from your INTERPRETATION, and be honest about confidence rather than hedging into mush. Each item states what its substance rests on in \"evidenceBasis\": \"packet\" means a structured extraction of the source document is attached in \"packet\"; \"document\" means the source's own text is in \"document\"; \"title_only\" means the substance was NOT retrieved and you must say so rather than inferring it from the title. A \"why\" field is a prior one-line note ABOUT the item — someone else's summary, not source text — so prefer the packet or document when they differ. Inside a packet, every string in \"evidence\" has been mechanically verified as a verbatim quote from the source, so those are safe to quote directly; \"claims\" are labelled fact / projection / assertion_by_party and an assertion_by_party is a named party's position, NOT an established fact; \"unknowns\" and \"notInDocument\" tell you what the source does not support, and you should respect them rather than filling the gap. An item with \"alsoFiledAs\" is ONE action filed in several places, not several corroborating items — never treat repetition as evidence. Cite item titles as markdown links when a URL is available; when you cite a market figure, name the series and its period (e.g. \"U.S. crush 210M bu, Apr 2026\"). Plain, professional English. You also have a WEB SEARCH tool — lean on the stored monitoring data first, but use the web to fill what it doesn't cover: the latest futures/cash prices, breaking news, or a figure or date worth verifying — anything more current than the last pipeline run. Reach for it when it makes the answer materially better or more current, not reflexively. Cite any web source inline as a markdown link so staff can tell web-sourced facts from the internal streams. Don't invent numbers — pull them.";
  // ⚠️ BLOCK ORDER IS LOAD-BEARING — IT IS WHAT MAKES PROMPT CACHING POSSIBLE (1.29.0).
  //
  // Caching is a PREFIX match, rendered `tools` → `system` → `messages`, and any byte change
  // invalidates everything after it. This user turn used to open with `Question: ${question}` at byte
  // ZERO, ahead of ~22,700 characters of market data that is identical for every question ever asked —
  // so nothing after the first line could ever be cached, and a breakpoint on the system prompt alone
  // would be ~620 tokens, UNDER Sonnet 5's 1,024-token minimum, and would have silently not cached.
  //
  // So the turn is now split by what actually varies:
  //   block 1 (CACHED) — every question-BLIND stream: market data, the derived reads, tracked,
  //                      deadlines, recent briefs. The breakpoint here covers tools + system + all of
  //                      this, ~7,000 tokens, comfortably over the minimum.
  //   block 2          — the retrieved items (ranked BY the question, so they vary with it) and the
  //                      question itself.
  //
  // Two payoffs. Every `pause_turn` resume turn below re-sends this whole request at full price today
  // and now re-reads the prefix at ~0.1x instead. And two DIFFERENT questions asked inside the cache
  // TTL share block 1 — the 15-minute askCache in server.js only dedupes *identical* questions, so
  // distinct questions are exactly the case prompt caching still pays for.
  const invariantContext =
    `=== MARKET DATA (latest value, change vs prior, recent trail) ===\n${marketBlock || "(no market data stored yet)"}\n\n` +
    (weatherRiskText() ? `=== CROP-WEATHER READ (anomaly vs. normal → supply/price) ===\n${weatherRiskText()}\n\n` : "") +
    (crushText() ? `=== CRUSH DEMAND (capacity utilization, cause→effect with margin) ===\n${crushText()}\n\n` : "") +
    (leadLagText() ? `=== MEASURED LEAD-LAG vs. DAILY PRICE (read the caveats) ===\n${leadLagText()}\n\n` : "") +
    (forecastTrackRecordText() ? `=== THIS TOOL'S OWN TRACK RECORD (past calls, scored) ===\n${forecastTrackRecordText()}\n\n` : "") +
    (surpriseText() ? `=== EXPECTATIONS vs. ACTUALS (surprise is what moves price, not the level) ===\n${surpriseText()}\n\n` : "") +
    (marketIntelText() ? `=== MARKET INTEL FROM NEWSLETTERS (distilled from the collector inbox, cited) ===\n${marketIntelText()}\n\n` : "") +
    `=== TRACKED ITEMS (pinned) ===\n${trackedBlock()}\n\n` +
    `=== UPCOMING COMMENT DEADLINES ===\n${deadlines.length ? deadlines.map((d) => `- ${d.comment_deadline}: ${d.title}${d.url ? ` ${d.url}` : ""}`).join("\n") : "(none)"}\n\n` +
    `=== RECENT BRIEFS ===\n${briefTexts.join("\n\n") || "(none)"}`;
  const questionContext =
    `=== LAWS/RULES/DECISIONS + NEWS items (JSON — one entry per government ACTION. "evidenceBasis" says what each rests on: "packet" = a verified structured extraction in "packet"; "document" = the source's own text; "title_only" = the substance was NOT retrieved. "why" is a prior one-line note, not source text. "alsoFiledAs" means the same action filed elsewhere — one action, not several.) ===\n${JSON.stringify(compactHits, null, 1)}\n\n` +
    `Question: ${question}`;
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: invariantContext, cache_control: { type: "ephemeral" } },
        { type: "text", text: questionContext },
      ],
    },
  ];
  // Web search is an Anthropic SERVER-side tool: the API runs the search loop and returns the final
  // answer — no client tool loop. A long server loop can stop with stop_reason "pause_turn"; re-send
  // to continue, bounded so it can't spin. web_search_20260209 needs Sonnet 5 / Opus 4.x (our
  // BRIEF_MODEL) and takes NO beta header. A search error returns as a result block, never a throw.
  let response;
  let webSearches = 0; // server_tool_use blocks across every turn — available before, discarded before
  for (let turn = 0; turn < 4; turn++) {
    response = await client.messages.create({
      model,
      max_tokens: 4500, // headroom for Sonnet 5 adaptive thinking + a web-augmented, cited answer
      system,
      tools: env.WEB_SEARCH === "off" ? undefined : [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }], // WEB_SEARCH=off → stored-data-only
      messages,
    });
    store.recordUsage(model, "query", response.usage.input_tokens, response.usage.output_tokens, response.usage);
    webSearches += response.content.filter((b) => b.type === "server_tool_use").length;
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content }); // echo blocks back unchanged to resume
  }
  // Web-augmented answers can span several text blocks (interleaved with search-result blocks) — join them.
  const answer = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim() || "(no answer)";

  // Log the ask. One write, after the answer is assembled, covering BOTH entry points (the homepage
  // box via answerQueryOnce and the `query` CLI) because both funnel through here.
  //
  // `unanswered` is derived DETERMINISTICALLY — no model judging its own output. Either nothing was
  // retrieved, or the answer used one of the phrases the system prompt explicitly instructs it to emit
  // when the stored data falls short. Cheap, honest, and disputable by reading the phrase list.
  try {
    store.logAsk({
      question,
      source,
      hits: merged.length,
      webSearches,
      answer,
      unanswered: merged.length === 0 || UNANSWERED_MARKERS.some((m) => answer.toLowerCase().includes(m)),
    });
  } catch (err) {
    // Never let instrumentation break an answer the user is waiting on.
    console.log(`⚠️  Ask logging skipped: ${err.message}`);
  }

  return { answer, hits: merged };
}

// Phrases the Ask system prompt tells the model to use when the stored data cannot support an answer
// ("say the substance was not retrieved rather than inferring it from the title"), plus the two
// early-return strings this module emits itself. Matching on these is what makes `unanswered` a
// deterministic signal rather than a second model call.
const UNANSWERED_MARKERS = [
  "substance was not retrieved",
  "not retrieved",
  "no stored series",
  "nothing stored yet matches",
  "i don't have",
  "isn't in the stored",
  "not in the stored data",
];

export async function runQuery(question, env) {
  console.log(`\n🔍 Searching stored briefs and items for: "${question}"…`);
  const { answer } = await answerQuery(question, env, "cli");
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
    // Phase 3: structure the note's claims and ground each one against real evidence ids. This is a
    // SECOND call because schema output and the web-search tool do not combine — see thesis.js.
    // When it succeeds it supersedes the Haiku extractor above; when it fails we fall back, so the
    // ledger keeps filling either way.
    buildTheses: true,
    // Phase 3b: one batched adversarial pass over those theses before the reader sees them. Batched
    // because the valuable checks are INTER-thesis (two theses resting on one datapoint) and a
    // per-thesis call cannot see them.
    challengeTheses: true,
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
  const deadlines = store.upcomingDeadlines(20); // pins are read inside trackedBlock(), capped + counted

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
  // A memo has no per-question part: the entire user turn is fixed for the life of the call. So ONE
  // cache_control breakpoint on the whole block covers tools + system + context, and every
  // `pause_turn` resume turn below re-reads that prefix at ~0.1x instead of re-paying for it. That is
  // the largest single saving available here — the Analyst preset runs ~30k input tokens on Opus with
  // web search on, so a 3-turn search loop used to bill that input three times over.
  const memoContext =
    `Stored monitoring data for the last ${preset.scopeDays} days — write the memo per your instructions.\n\n` +
    `=== MARKET DATA (latest value, change vs prior, recent trail) ===\n${marketBlock || "(no market data stored yet)"}\n\n` +
    (marketIntelText() ? `=== MARKET INTEL FROM NEWSLETTERS (distilled from the collector inbox, cited) ===\n${marketIntelText()}\n\n` : "") +
    `=== LAWS/RULES/DECISIONS + NEWS items (JSON — one entry per government ACTION. "evidenceBasis" says what each rests on: "packet" = a verified structured extraction in "packet"; "document" = the source's own text; "title_only" = the substance was NOT retrieved. "why" is a prior one-line note, not source text. "alsoFiledAs" means the same action filed elsewhere — one action, not several.) ===\n${JSON.stringify(compactHits, null, 1)}\n\n` +
    `=== TRACKED ITEMS (pinned) ===\n${trackedBlock()}\n\n` +
    `=== UPCOMING COMMENT DEADLINES ===\n${deadlines.length ? deadlines.map((d) => `- ${d.comment_deadline}: ${d.title}${d.url ? ` ${d.url}` : ""}`).join("\n") : "(none)"}\n\n` +
    `=== DAILY BRIEFS IN WINDOW ===\n${briefTexts.join("\n\n") || "(none)"}` +
    curriculumBlock +
    signalsBlock;
  const request = {
    model,
    max_tokens: preset.maxTokens,
    system: preset.system(dateLabel),
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: memoContext, cache_control: { type: "ephemeral" } }],
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
    store.recordUsage(model, "memo", response.usage.input_tokens, response.usage.output_tokens, response.usage);
    if (response.stop_reason !== "pause_turn") break;
    request.messages.push({ role: "assistant", content: response.content }); // echo blocks back unchanged to resume
  }
  // Web-augmented notes can span several text blocks (interleaved with search-result blocks) — join them.
  const noteMarkdown = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();

  // ── PHASE 3, CALL 2: structure the note's claims and ground them ────────────────────────────────
  //
  // Runs BEFORE saveBrief on purpose, so the rendered theses are part of the saved file and
  // therefore part of what is delivered. A thesis block that existed only in the DB would never be
  // read by the person the note is for.
  //
  // Fail-soft in both directions: `buildTheses` returns null on any error, and the note is saved
  // and delivered exactly as before. Structuring is an enhancement to the note, never a gate on it.
  // ⚠️ EVERY line between the model call and saveBrief is inside this try, including the cheap
  // local lookups that assemble the universe. By this point the note has been generated and PAID
  // FOR (an Analyst run is ~$0.79); a throw here — a signal that cannot compute on a thin DB, a
  // market snapshot that comes back empty — would lose it before it was ever written to disk. An
  // enhancement must never be able to destroy the deliverable it is enhancing.
  let theses = null;
  if (preset.buildTheses) {
    try {
      const snapshot = store.marketSnapshot();
      // The universe is what the model was ACTUALLY SHOWN. Offering an id that is real but absent
      // from the prompt would invite a citation the model cannot have read.
      const universe = {
        itemUids: new Set(compactHits.map((h) => h.uid).filter(Boolean)),
        seriesIds: new Set(snapshot.map((s) => s.series)),
        // `.signals` — computeSignals returns a BOARD ({signals, tilt, factors, …}), not an array.
        // Calling .map on the wrapper throws, and because this whole block is fail-soft the only
        // symptom was the analyst quietly falling back to the old extractor on every run. Caught by
        // test/thesis-wiring.test.js, which is the argument for that file existing.
        signalIds: new Set((computeSignals().signals ?? []).map((s) => s.id)),
        briefPaths: new Set(store.listBriefs(40).map((b) => b.path)),
        reportKeys: new Set(),
      };
      const evidenceIds = [
        ...[...universe.itemUids].map((u) => `item:${u}`),
        ...snapshot.map((s) => `series:${s.series}@${s.latest?.period ?? "latest"}`),
        ...[...universe.signalIds].map((s) => `signal:${s}`),
        ...[...universe.briefPaths].map((b) => `brief:${b}`),
      ];
      const built = await buildTheses(noteMarkdown, {
        evidenceIds,
        universe,
        env,
        client,
        recordUsage: (m, kind, i, o, usage) => store.recordUsage(m, kind, i, o, usage),
      });
      theses = built?.theses?.length ? built.theses : null;
    } catch (err) {
      console.log(`⚠️  Thesis structuring skipped: ${err.message}`);
    }
  }

  // ── PHASE 3b: one adversarial pass before the reader sees any of it ─────────────────────────────
  //
  // Also inside a try, and for the same reason: by this point the note exists and has been paid for.
  // A Challenger failure must cost us the review, never the note. When it fails, `applied` stays
  // null, the theses render unchallenged, and each is persisted with a NULL verdict — so the
  // database can always distinguish "approved" from "never reviewed".
  let applied = null;
  let noteLevelConcern = "";
  let challengerModel = null;
  if (theses && preset.challengeTheses) {
    try {
      const context =
        `=== MEASURED LEAD-LAG (no significant lead is the CORRECT result of a corrected scan, not a gap) ===\n${leadLagText()}\n\n` +
        `=== MARKET SERIES HISTORY DEPTH (for history_sufficient) ===\n` +
        store
          .marketSnapshot()
          .map((s) => `${s.series}: ${s.history?.n ?? "?"} observations, range ${s.history?.min ?? "?"}–${s.history?.max ?? "?"}`)
          .join("\n");
      const challenged = await challengeTheses(theses, {
        context,
        env,
        client,
        recordUsage: (m, kind, i, o, usage) => store.recordUsage(m, kind, i, o, usage),
      });
      if (challenged) {
        applied = applyChallenges(theses, challenged.challenges);
        noteLevelConcern = challenged.noteLevelConcern;
        challengerModel = challenged.model;
        const counts = {};
        for (const t of applied.all) counts[t.verdict ?? "unreviewed"] = (counts[t.verdict ?? "unreviewed"] ?? 0) + 1;
        console.log(`   ⚔️  Challenger: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
      }
    } catch (err) {
      console.log(`⚠️  Thesis challenge skipped: ${err.message}`);
    }
  }

  // Rejected theses are removed from what the reader sees but survive in `applied.rejected` so they
  // can be persisted with their reason — a rejected read that is merely deleted comes back next week
  // looking new.
  const shownTheses = applied ? applied.kept : theses;
  const thesisBlock = shownTheses?.length ? `\n\n${renderTheses(shownTheses)}` : "";
  const weaknessBlock = applied ? renderWeakness(applied, noteLevelConcern) : "";
  const markdown = noteMarkdown + thesisBlock + (weaknessBlock ? `\n\n${weaknessBlock}` : "");
  const filePath = saveBrief(markdown, preset.edition, timezone);
  const briefPath = path.relative(store.DATA_DIR, filePath);

  // Persist AFTER saving, because `thesis_key` is `<brief_path>#<index>` and the path is not known
  // until the file exists. Position-based rather than a hash of the model's wording: `dedupe_key` on
  // forecasts hashes the claim TEXT, so a re-run that paraphrases yields a different key and a
  // duplicate row. Position within a note is stable under paraphrase.
  if (theses) {
    try {
      const createdAt = new Date().toISOString();
      const rows = applied ? applied.all : theses.map((t) => ({ ...t, verdict: null, rejected: false, checks: null }));
      rows.forEach((t, i) => {
        const thesisKey = `${briefPath}#${i}`;
        store.upsertThesis({ ...t, thesisKey, briefPath, edition: preset.edition, createdAt });
        if (t.verdict) {
          store.recordChallenge({
            thesisKey,
            briefPath,
            createdAt,
            verdict: t.verdict,
            reason: t.challengeReason,
            caveat: t.caveat,
            model: challengerModel,
            ...(t.checks ?? {}),
          });
        }
        t.thesisKey = thesisKey; // carried into the ledger below
      });
    } catch (err) {
      console.log(`⚠️  Thesis persistence skipped: ${err.message}`);
    }
  }

  // File the note's falsifiable claims so they can be scored later. Fail-soft: a memo is worth
  // saving even if extraction hiccups, and the ledger self-heals on the next run.
  //
  // The thesis path SUPERSEDES the Haiku extractor rather than running alongside it — two filing
  // paths over the same note would double-file every claim under two different wordings, and the
  // dedupe key is a hash of the claim text, so nothing downstream would catch it. When structuring
  // produced nothing we fall back, so the ledger keeps filling exactly as it did before Phase 3.
  if (theses) {
    // Wrapped for the same reason the extractor branch below always was: the note is saved by now,
    // but runMemo still has to DELIVER it. A throw here would leave a saved note that never reaches
    // the reader — the failure mode v1.29.0's alerts fix was written to end.
    try {
      const bySeries = new Map(store.marketSnapshot().map((s) => [s.series, s]));
      const createdAt = new Date().toISOString();
      let stored = 0;
      // Only KEPT theses are filed. A rejected read is not a prediction the system made, so it must
      // not enter the track record that later prompts are shown. The honest cost of that choice:
      // rejection accuracy is unmeasurable — we never find out whether a rejected thesis would have
      // been right. The measurement the plan actually wanted (do challenged-DOWN claims hit less
      // often than approved ones?) compares approve vs lower_confidence, and both are kept.
      for (const t of shownTheses ?? []) {
        const fc = t.falsifiableClaim;
        if (!fc?.claim) continue;
        // Flatten the thesis schema into the ledger's common shape. horizon and confidence live on
        // the thesis, not on the claim — and `confidence` is the POST-grounding, POST-challenge
        // value, so a thesis demoted at either step files at the confidence we actually hold.
        const filed = fileForecastFromClaim(
          { ...fc, horizonDays: t.horizonDays, confidence: t.confidence },
          { briefPath, edition: preset.edition, createdAt, bySeries, thesisKey: t.thesisKey ?? null, challengeVerdict: t.verdict ?? null }
        );
        if (filed) stored++;
      }
      if (stored) console.log(`🔮 Forecast ledger: ${stored} claim${stored === 1 ? "" : "s"} filed from ${preset.edition} theses`);
    } catch (err) {
      console.log(`⚠️  Thesis forecast filing skipped: ${err.message}`);
    }
  } else if (preset.extractForecasts) {
    try {
      await extractForecasts(noteMarkdown, { edition: preset.edition, briefPath, env });
    } catch (err) {
      console.log(`⚠️  Forecast extraction skipped: ${err.message}`);
    }
  }
  return { markdown, filePath, edition: preset.edition, theses };
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
  // ⚠️ THE PRIOR STATE IS THE FIX (1.30.0). This used to be `listStorylines(20).map(s => s.name)` — a
  // bare list of NAMES. The model was told to "continue existing threads" while being given no idea
  // what any of them previously said, so it could only re-summarize the current 21-day window from
  // scratch. That is why the panel restated whole threads instead of showing what moved: a delta was
  // literally not computable from the inputs.
  //
  // Now each thread arrives with its previous summary, open questions and expected next event, so
  // "what is new" is a comparison the model can actually make. ~700 chars x 10 threads ≈ 1,750 input
  // tokens, which is the cheapest part of this call.
  const priorThreads = store.listStorylines(10);
  const priorBlock = priorThreads.length
    ? priorThreads
        .map((s) => {
          const tl = (s.timeline ?? []).slice(0, 3).map((e) => `      · ${e.date} ${e.event}`).join("\n");
          return (
            `- ${s.name} [${s.key}] · last updated ${(s.updated_at || "").slice(0, 10)}` +
            `${s.materiality ? ` · materiality ${s.materiality}` : ""}${s.state ? ` · previous state ${s.state}` : ""}\n` +
            `    previous summary: ${s.summary || "(none)"}\n` +
            `${(s.openQuestions ?? []).length ? `    still open: ${(s.openQuestions ?? []).join("; ")}\n` : ""}` +
            `${s.nextExpected?.what ? `    was expecting next: ${s.nextExpected.what}${s.nextExpected.when ? ` (${s.nextExpected.when})` : ""}\n` : ""}` +
            `${tl ? `    known timeline:\n${tl}\n` : ""}`
          );
        })
        .join("\n")
    : "(no threads yet — everything you produce is new)";

  const system =
    `You maintain the "storylines" for the Iowa Soybean Association's policy & market monitor — the handful of ongoing THREADS the news is really about (e.g. "45Z Clean Fuel Production Credit", "EU Deforestation Regulation (EUDR)", "Summit Carbon CO2 Pipeline", "Renewable diesel & soybean-oil demand", "China soybean trade"). Cluster the monitoring items below into 3–7 active storylines.\n\n` +
    `YOUR JOB IS THE TRANSITION, NOT A RE-SUMMARY. For each thread you are given its PREVIOUS state — the summary it last carried, what was still open, and what event it was waiting for. Write what MOVED since then: "whatIsNew" must contain only what a reader who already knew that previous state would not know, and must be an empty string when nothing moved. Say "unchanged" in stateChange honestly rather than manufacturing movement — a thread that genuinely did not move is useful information.\n\n` +
    `CONTINUE existing threads by their EXACT name and key where items fit one — do not rename or fork a thread that already exists. Only include storylines with genuine recent activity in these items, PLUS any existing thread whose state changed; ignore one-off noise that belongs to no thread.\n\n` +
    `Timeline most-recent-first, max 5 NEW entries — the thread's older dated events are already stored and will be merged, so do not repeat entries already shown to you under "known timeline". Dates come from the item dates. Keys are stable kebab slugs. Use an empty string for a timeline url when the item has none.`;
  const user =
    `EXISTING THREADS AND THEIR PREVIOUS STATE (continue these by exact name/key; compare against these to find the delta):\n${priorBlock}\n\n` +
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
  let moved = 0; // threads whose state actually changed — the number worth reporting
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
    const clampStr = (v, n) => (v ? String(v).slice(0, n) : null);
    // ⚠️ The delta gets its OWN column — it is not folded into `summary`. An earlier pass prefixed the
    // summary with a markdown "**What's new:**", which the homepage panel renders through `esc()` and
    // would have displayed as literal asterisks. Storage should not encode one consumer's formatting.
    // An empty `whatIsNew` is the honest "nothing moved" case and must stay empty.
    store.upsertStoryline({
      key,
      name: String(s.name).slice(0, 120),
      focus: clampStr(s.focus, 200),
      summary: clampStr(s.whatChanged, 800),
      whatIsNew: clampStr(s.whatIsNew, 600),
      timeline,
      itemCount: timeline.length,
      state: ["new", "advanced", "stalled", "resolved", "unchanged"].includes(s.stateChange) ? s.stateChange : null,
      openQuestions: Array.isArray(s.openQuestions) ? s.openQuestions.filter(Boolean).slice(0, 6).map((q) => String(q).slice(0, 240)) : [],
      nextExpected: s.nextExpectedEvent?.what
        ? {
            what: String(s.nextExpectedEvent.what).slice(0, 240),
            when: String(s.nextExpectedEvent.when || "").slice(0, 40),
            why: String(s.nextExpectedEvent.why || "").slice(0, 240),
          }
        : null,
      materiality: ["decision_changing", "monitor", "context"].includes(s.materiality) ? s.materiality : null,
    });
    saved++;
    if (s.stateChange && s.stateChange !== "unchanged") moved++;
  }
  const pruned = store.pruneStorylines(30);
  store.setState("storylines_meta", JSON.stringify({ generatedAt: new Date().toISOString(), count: saved, moved }));
  console.log(
    `🧵 Storylines: ${saved} active thread${saved === 1 ? "" : "s"} — ${moved} moved, ${saved - moved} unchanged` +
      (pruned ? ` (${pruned} aged off)` : "")
  );
  return { count: saved, moved };
}

// --- forecast ledger: extract → store → resolve → feed back ---------------------------------
//
// The Analyst prompt already asks for a falsifiable read (setup / risk / what would confirm or kill
// it). This turns that prose into typed, dated rows so the tool can be SCORED, and then feeds the
// scored record back into later prompts. Without this the system had no memory of its own claims and
// no way to answer "has this thing been right?".
//
// Extraction uses STRUCTURED OUTPUTS (`output_config.format` + a json_schema) rather than asking for
// JSON in the prompt and parsing it out of prose, which removes the whole class of silent
// malformed-response failures.
//
// The three schema-constrained call sites are this one (FORECAST_SCHEMA), generateStorylines
// (STORYLINE_SCHEMA) and extractExpectations (EXPECTATION_SCHEMA). The two remaining prose-parsers are
// triage.js and newsrank.js, which hand-roll a fence-strip plus a bracket-slice fallback — if you are
// adding a new JSON-producing call, copy the pattern here rather than those.
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
    if (fileForecastFromClaim(f, { briefPath, edition, createdAt, bySeries })) stored++;
  }
  if (stored) console.log(`🔮 Forecast ledger: ${stored} claim${stored === 1 ? "" : "s"} filed from ${edition}`);
  return { stored };
}

/**
 * File ONE falsifiable claim in the ledger.
 *
 * Lifted out of `extractForecasts` unchanged so that the thesis path (thesis.js, Phase 3) and the
 * legacy Haiku extractor apply the SAME guards — the level-claim threshold rule, the
 * series-must-exist rule, and capturing the baseline at filing time — and so `resolveForecasts()`
 * needs zero changes to score a thesis-filed row identically to an extractor-filed one. Two filing
 * paths with two copies of these rules is how the ledger would start disagreeing with itself.
 *
 * `f` is the common shape: { claim, comparator, threshold, direction, series, horizonDays,
 * confirmingEvent, confidence }. The thesis path flattens its own schema into this before calling.
 *
 * @returns {boolean} whether a row was written
 */
export function fileForecastFromClaim(f, { briefPath, edition, createdAt, bySeries, thesisKey = null, challengeVerdict = null }) {
  if (!f?.claim) return false;
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
    // Null on the legacy extractor path. `challengeVerdict` is what later answers whether the
    // Challenger earns its money — see store.challengeScorecard().
    thesisKey,
    challengeVerdict,
  });
  return true;
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
          // --- the delta fields (1.30.0): what makes this a state TRANSITION rather than a re-summary
          stateChange: {
            type: "string",
            enum: ["new", "advanced", "stalled", "resolved", "unchanged"],
            description:
              "How this thread moved since its previous state, which is given to you. Use 'unchanged' honestly when nothing moved — that is useful information, not a failure.",
          },
          whatIsNew: {
            type: "string",
            description:
              "ONLY the delta since the previous state shown to you — what a reader who already knew that state would not know. Empty string when nothing changed. Do NOT restate the thread.",
          },
          whatIsUnchanged: {
            type: "string",
            description: "Which parts of the previous read still hold. Empty string if this is a brand-new thread.",
          },
          openQuestions: {
            type: "array",
            items: { type: "string" },
            description: "What is still unresolved on this thread. Empty array if nothing.",
          },
          nextExpectedEvent: {
            type: "object",
            properties: {
              what: { type: "string", description: "The report, hearing, decision or filing that would move this thread. Empty string if unknown." },
              when: { type: "string", description: "A date (YYYY-MM-DD) or a rough window like 'Q4 2026'. Empty string if unknown." },
              why: { type: "string", description: "One line: why that event matters to this thread. Empty string if unknown." },
            },
            required: ["what", "when", "why"],
            additionalProperties: false,
          },
          materiality: {
            type: "string",
            enum: ["decision_changing", "monitor", "context"],
            description:
              "decision_changing = ISA would act or brief leadership on this; monitor = worth watching; context = background only.",
          },
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
        required: [
          "key",
          "name",
          "focus",
          "whatChanged",
          "stateChange",
          "whatIsNew",
          "whatIsUnchanged",
          "openQuestions",
          "nextExpectedEvent",
          "materiality",
          "timeline",
        ],
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

  // Does the Challenger earn its money? The plan set a kill criterion — an approve rate near 100%
  // after ~20 notes means cut it — and a criterion nobody can see is a criterion nobody applies. So
  // it prints here, next to the spend it is being weighed against, rather than living in a table
  // somebody would have to know to query.
  const cs = store.challengeScorecard();
  if (cs.totalChallenged > 0) {
    console.log(`\nThesis Challenger: ${cs.totalChallenged} verdict${cs.totalChallenged === 1 ? "" : "s"}`);
    console.log(`   ${Object.entries(cs.verdictCounts).map(([v, n]) => `${n} ${v}`).join(", ")}`);
    console.log(`   approve rate ${(cs.approveRate * 100).toFixed(0)}%`);
    const judged = Object.entries(cs.byVerdict).filter(([, v]) => v.judged > 0);
    if (judged.length) {
      console.log("   hit rate by verdict (the measurement that says whether it is worth it):");
      for (const [v, s] of judged) console.log(`      ${v.padEnd(18)} ${s.hit}/${s.judged} = ${(s.hitRate * 100).toFixed(0)}%`);
    } else {
      console.log("   (no challenged claim has resolved yet — hit rate by verdict needs time)");
    }
    if (cs.totalChallenged >= 20 && cs.approveRate >= 0.95) {
      console.log("   ⚠️  Approve rate ≥95% over 20+ verdicts — this is the stated CUT criterion.");
      console.log("      The Challenger is agreeing with everything; consider removing it (src/challenger.js).");
    }
  }

  console.log("\nAnthropic usage this month:");
  if (monthUsage.length === 0) console.log("   (no Anthropic calls yet)");
  let totalCost = 0;
  let anyCache = false;
  for (const row of monthUsage) {
    const price = PRICES[row.model] ?? { input: 3.0, output: 15.0 };
    const cacheRead = row.cache_read_tokens ?? 0;
    const cacheWrite = row.cache_write_tokens ?? 0;
    if (cacheRead || cacheWrite) anyCache = true;
    // ⚠️ `input_tokens` is the UNCACHED REMAINDER only — total prompt size is
    // input + cache_write + cache_read. Before 1.29.0 this line was the whole cost, which was correct
    // only while nothing was cached; leaving it that way once caching is on would silently omit the
    // cached tokens entirely and make caching look free rather than merely cheap.
    const cost =
      (row.input_tokens / 1e6) * price.input +
      (cacheWrite / 1e6) * price.input * CACHE_WRITE_MULTIPLIER +
      (cacheRead / 1e6) * price.input * CACHE_READ_MULTIPLIER +
      (row.output_tokens / 1e6) * price.output;
    totalCost += cost;
    const cacheNote = cacheRead || cacheWrite ? `, cache ${cacheRead} read / ${cacheWrite} written` : "";
    console.log(
      `   ${row.model.padEnd(20)} ${String(row.calls).padStart(4)} calls, ` +
        `${String(row.input_tokens).padStart(9)} in / ${String(row.output_tokens).padStart(8)} out tokens${cacheNote} ≈ $${cost.toFixed(2)}`
    );
  }
  if (monthUsage.length > 0) console.log(`   ${"".padEnd(20)} estimated month-to-date total ≈ $${totalCost.toFixed(2)}`);
  if (monthUsage.length > 0 && !anyCache) {
    console.log("\n   ⚠️  No prompt-cache activity recorded. The Ask box and memos set a cache breakpoint,");
    console.log("       so zero reads AND zero writes across several calls means the cached prefix is being");
    console.log("       invalidated — run `tokens` for the per-purpose breakdown.");
  }
  console.log();
}

/**
 * Per-purpose token + cache breakdown — the verification tool for prompt caching.
 *
 * `audit` groups by MODEL, which mixes cached and uncached purposes on the same model (Sonnet 5 runs
 * both the uncached brief and the cached Ask box), so a zero there is ambiguous. Grouping by purpose
 * is what actually answers "did the breakpoint hold?": `query` and `memo` should show cache reads
 * once the same prefix is hit twice; `triage` and `newsrank` should show none, because they run on
 * Haiku 4.5 whose minimum cacheable prefix is 4,096 tokens — larger than those prompts.
 */
export async function runTokens(days = 30) {
  const rows = store.getUsageByPurpose(days);
  console.log(`\n🔢 Token usage by purpose, last ${days} days\n`);
  if (rows.length === 0) {
    console.log("   (no Anthropic calls recorded yet)\n");
    return;
  }
  // 18 wide: the longest purpose in use is `forecast_extract` (16), which overran a 14-wide column
  // and ran into the model name.
  console.log(`   ${"purpose".padEnd(18)}${"model".padEnd(20)}${"calls".padStart(6)}${"in".padStart(10)}${"out".padStart(9)}${"cache rd".padStart(10)}${"cache wr".padStart(10)}`);
  for (const r of rows) {
    console.log(
      `   ${String(r.purpose).padEnd(18)}${String(r.model).padEnd(20)}${String(r.calls).padStart(6)}` +
        `${String(r.input_tokens).padStart(10)}${String(r.output_tokens).padStart(9)}` +
        `${String(r.cache_read_tokens ?? 0).padStart(10)}${String(r.cache_write_tokens ?? 0).padStart(10)}`
    );
  }
  const cached = rows.filter((r) => (r.cache_read_tokens ?? 0) > 0);
  console.log(
    cached.length
      ? `\n   ✅ Prompt cache is being READ on: ${cached.map((r) => r.purpose).join(", ")}\n`
      : `\n   ⚠️  No cache reads on any purpose. Expected on 'query' and 'memo' once a prefix is hit twice.\n`
  );
}
