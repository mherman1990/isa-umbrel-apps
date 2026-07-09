// collect.js — orchestrates all adapters for one run.
//
// For each enabled source: compute its incremental window (last successful run,
// capped at 7 days on first run), call the adapter within its item budget, and
// filter out items we've already seen. A failing source logs a warning and is
// recorded as skipped — the run always continues with whatever worked ("fail soft").

import { adapters } from "./adapters/index.js";
import * as store from "./store.js";
import { channelsForKinds } from "./registry.js";
import { mapPool } from "./util.js";

// How many sources to fetch at once. They hit independent hosts, so the network phase becomes
// the slowest source rather than the sum — while a small cap stays gentle on the machine.
const COLLECT_CONCURRENCY = 6;

/**
 * @param {object} opts
 * @param {object} opts.watchlist  parsed watchlist.json
 * @param {object} opts.env        process.env
 * @param {string|null} opts.onlySource  restrict to a single source id (testing)
 * @param {boolean} opts.commit    real run: advance last-success timestamps.
 *                                 dry-run: read-only, never changes state.
 * @returns {{ items: Item[], skippedSources: {id, label, reason}[], fetchedCount: number }}
 */
export async function collectAll({ watchlist, env, onlySource = null, commit = true }) {
  if (onlySource && !adapters[onlySource]) {
    const known = Object.keys(adapters).join(", ");
    throw new Error(`Unknown source "${onlySource}". Known sources: ${known}`);
  }

  // Decide which sources run this cycle (same filters as before: onlySource, missing config,
  // disabled). The "no watchlist entry" warning still fires here, before any fetching.
  const targets = [];
  for (const [sourceId, adapter] of Object.entries(adapters)) {
    if (onlySource && sourceId !== onlySource) continue;
    const sourceConfig = watchlist.sources?.[sourceId];
    if (!sourceConfig) {
      console.log(`⚠️  ${adapter.label}: no entry in watchlist.json "sources" — skipping`);
      continue;
    }
    if (!sourceConfig.enabled && !onlySource) continue;
    targets.push({ sourceId, adapter, sourceConfig });
  }

  // Fetch sources concurrently (bounded). Each keeps its own try/catch, so one source's failure
  // is recorded independently and never kills the run ("fail soft"). better-sqlite3 is
  // synchronous, so the isSeen/setLastSuccess reads and writes still serialize safely — only the
  // network awaits overlap. Results come back in source order, so item ordering is unchanged.
  const settled = await mapPool(targets, COLLECT_CONCURRENCY, async ({ sourceId, adapter, sourceConfig }) => {
    const runStartedAt = new Date().toISOString();
    const sinceISO = store.getSince(sourceId);
    try {
      // Entity-driven adapters (e.g. rss, ical, mobilize, email_intake) declare the
      // registry channel kinds they consume; topic-query adapters ignore `channels`.
      const channels = adapter.channelKinds ? channelsForKinds(adapter.channelKinds) : [];
      const fetched = await adapter.fetchItems({
        sinceISO,
        topics: watchlist.topics ?? [],
        sourceConfig,
        channels,
        env,
      });
      const fresh = fetched.filter((item) => !store.isSeen(item.uid));
      console.log(
        `📥 ${adapter.label}: ${fetched.length} fetched since ${sinceISO.slice(0, 10)}, ${fresh.length} new`
      );
      if (commit) store.setLastSuccess(sourceId, runStartedAt);
      return { fresh, fetched: fetched.length };
    } catch (err) {
      console.log(`⚠️  ${adapter.label}: skipped — ${err.message}`);
      return { skipped: { id: sourceId, label: adapter.label, reason: err.message } };
    }
  });

  const items = [];
  const skippedSources = [];
  let fetchedCount = 0;
  for (const r of settled) {
    if (r.skipped) {
      skippedSources.push(r.skipped);
      continue;
    }
    items.push(...r.fresh);
    fetchedCount += r.fetched;
  }

  return { items, skippedSources, fetchedCount };
}
