// score.js — local keyword/topic scoring. Runs BEFORE any Anthropic call, costs nothing.
//
// Each item's title + summary is scanned for every topic's keywords (case-insensitive,
// word-boundary matching so "RIN" doesn't match "brine"). Each matched topic adds its
// weight once. Items mentioning Iowa or soybeans get a small boost. Items below
// output.minLocalScoreForTriage are dropped; the rest are capped at output.maxItemsToTriage.
// Claude never sees the unfiltered firehose.
//
// EXCLUSIONS (added 1.26.0). Until now the filter could only ever say YES: there was no way to
// express "this word means I don't care", so a recurring category of noise could only be fought by
// making the include-terms narrower, which loses real hits too. Two levers now:
//   output.excludeTerms       — global. A match drops the item before triage, whatever it scored.
//   focusArea.excludeTerms    — per area. A match means THAT area doesn't count toward the score,
//                               so a bill that hits "pesticide" in a school-lunch context stops
//                               claiming the crop-protection weight but can still qualify elsewhere.
// Word-boundary matched like the include terms, so "RIN" never matches "brine".

import { keywordRegex } from "./util.js";

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
  const globalExclude = (output?.excludeTerms ?? []).map(keywordRegex);

  // Pre-compile every topic's keyword regexes once.
  const compiled = topics.map((topic) => ({
    topic,
    regexes: (topic.keywords ?? []).map(keywordRegex),
    excludes: (topic.excludeTerms ?? []).map(keywordRegex),
  }));

  let excluded = 0;
  const scored = items.map((item) => {
    const text = `${item.title ?? ""}\n${item.summary ?? ""}`;
    let score = 0;
    const matchedTopics = [];
    // A global exclusion term is a hard NO — score 0 so it can't clear minScore however many
    // include-terms it hit. Recorded as seen either way, so it stays searchable in the diagnostic.
    if (globalExclude.some((re) => re.test(text))) {
      excluded++;
      return { ...item, localScore: 0, matchedTopics: [], excludedBy: "global" };
    }
    for (const { topic, regexes, excludes } of compiled) {
      // A topic counts if its keywords appear in the title/summary, OR if the
      // adapter found this item via that topic's watchlist query (important for
      // state bills, whose titles are often generic — the query matched the
      // bill's full text on the source's side).
      const foundByQuery = item.raw?.matchedTopicId === topic.id;
      if (excludes.length && excludes.some((re) => re.test(text))) continue; // this area opts out
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
  return { kept, dropped: scored.length - kept.length, excluded };
}
