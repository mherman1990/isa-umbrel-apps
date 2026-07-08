// score.js — local keyword/topic scoring. Runs BEFORE any Anthropic call, costs nothing.
//
// Each item's title + summary is scanned for every topic's keywords (case-insensitive,
// word-boundary matching so "RIN" doesn't match "brine"). Each matched topic adds its
// weight once. Items mentioning Iowa or soybeans get a small boost. Items below
// output.minLocalScoreForTriage are dropped; the rest are capped at output.maxItemsToTriage.
// Claude never sees the unfiltered firehose.

/** Build a word-boundary regex for a keyword; escapes regex specials. */
function keywordRegex(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // \b doesn't work adjacent to non-word chars (e.g. "45Z"), so use lookarounds.
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i");
}

const BOOST_TERMS = ["Iowa", "soybean", "soy oil"].map(keywordRegex);

/**
 * @param {Item[]} items
 * @param {object[]} topics    watchlist.json "topics"
 * @param {object} output      watchlist.json "output" (thresholds)
 * @returns {{ kept: (Item & {localScore, matchedTopics})[], dropped: number }}
 */
export function scoreItems(items, topics, output) {
  const minScore = output?.minLocalScoreForTriage ?? 5;
  const maxToTriage = output?.maxItemsToTriage ?? 80;
  const entityBoost = output?.entitySourceBoost ?? 6;

  // Pre-compile every topic's keyword regexes once.
  const compiled = topics.map((topic) => ({
    topic,
    regexes: (topic.keywords ?? []).map(keywordRegex),
  }));

  const scored = items.map((item) => {
    const text = `${item.title ?? ""}\n${item.summary ?? ""}`;
    let score = 0;
    const matchedTopics = [];
    for (const { topic, regexes } of compiled) {
      // A topic counts if its keywords appear in the title/summary, OR if the
      // adapter found this item via that topic's watchlist query (important for
      // state bills, whose titles are often generic — the query matched the
      // bill's full text on the source's side).
      const foundByQuery = item.raw?.matchedTopicId === topic.id;
      if (foundByQuery || regexes.some((re) => re.test(text))) {
        score += topic.weight; // each topic counts once, however many keywords hit
        matchedTopics.push({ id: topic.id, label: topic.label });
      }
    }
    if (BOOST_TERMS.some((re) => re.test(text))) score += 3;
    // Registry-sourced items (rss/email-intake) are curated by definition — boost
    // them so a tracked entity's post clears the local filter even when it doesn't
    // hit a topic keyword. Keyword hits still stack on top for ranking.
    // Exception: broad news publishers (email_intake sets raw.suppressEntityBoost) are
    // attributed for labeling but must earn their way in on relevance, not auto-clear.
    if (item.raw?.entityId && !item.raw?.suppressEntityBoost) score += entityBoost;
    return { ...item, localScore: score, matchedTopics };
  });

  scored.sort((a, b) => b.localScore - a.localScore);
  const kept = scored.filter((s) => s.localScore >= minScore).slice(0, maxToTriage);
  return { kept, dropped: scored.length - kept.length };
}
