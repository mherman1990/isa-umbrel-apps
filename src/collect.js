// collect.js — orchestrates all adapters for one run.
//
// For each enabled source: compute its incremental window (last successful run,
// capped at 7 days on first run), call the adapter within its item budget, and
// filter out items we've already seen. A failing source logs a warning and is
// recorded as skipped — the run always continues with whatever worked ("fail soft").

import { adapters } from "./adapters/index.js";
import * as store from "./store.js";
import { channelsForKinds } from "./registry.js";

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
  const items = [];
  const skippedSources = [];
  let fetchedCount = 0;

  for (const [sourceId, adapter] of Object.entries(adapters)) {
    const sourceConfig = watchlist.sources?.[sourceId];
    if (onlySource && sourceId !== onlySource) continue;
    if (!sourceConfig) {
      console.log(`⚠️  ${adapter.label}: no entry in watchlist.json "sources" — skipping`);
      continue;
    }
    if (!sourceConfig.enabled && !onlySource) continue;

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
      fetchedCount += fetched.length;
      const fresh = fetched.filter((item) => !store.isSeen(item.uid));
      console.log(
        `📥 ${adapter.label}: ${fetched.length} fetched since ${sinceISO.slice(0, 10)}, ${fresh.length} new`
      );
      items.push(...fresh);
      if (commit) store.setLastSuccess(sourceId, runStartedAt);
    } catch (err) {
      console.log(`⚠️  ${adapter.label}: skipped — ${err.message}`);
      skippedSources.push({ id: sourceId, label: adapter.label, reason: err.message });
    }
  }

  if (onlySource && !adapters[onlySource]) {
    const known = Object.keys(adapters).join(", ");
    throw new Error(`Unknown source "${onlySource}". Known sources: ${known}`);
  }

  return { items, skippedSources, fetchedCount };
}
