// triggers.js — the BeanBrief condition-trigger engine.
//
// Evaluates the marketing condition triggers (src/data/condition_triggers.json) against today's
// date + our stored market data + the report calendar, applies the suppress_if / guardrail rules,
// and ranks the fired triggers by priority for the education-card synthesis. See
// docs/BEANBRIEF_MARKETING_CONTEXT.md (the domain + compliance bible) §1, §5, §7.
//
// This is EDUCATION plumbing: it decides which teachable market states are active. The compliant
// card copy is written downstream (pipeline.generateMarketCards) with the guardrails in compliance.js.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as store from "./store.js";
import { nextImpactfulReport } from "./calendar.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
let CFG = null;
function load() {
  if (CFG) return CFG;
  try {
    CFG = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "condition_triggers.json"), "utf8"));
  } catch {
    CFG = { triggers: [] };
  }
  return CFG;
}

const mmdd = (d) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

/** Parse "today BETWEEN 'MM-DD' AND 'MM-DD'" out of the (documentary) expression, or null. */
function dateWindow(expr, now) {
  const m = /BETWEEN '(\d{2}-\d{2})' AND '(\d{2}-\d{2})'/.exec(expr || "");
  if (!m) return null;
  const t = mmdd(now), a = m[1], b = m[2];
  return a <= b ? t >= a && t <= b : t >= a || t <= b; // tolerate a year-wrap window
}

const round = (v) => (v == null ? "—" : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Math.round(v * 100) / 100);

// Triggers whose firing depends on live data (beyond the date window). Others are date-only.
//
// ⚠️ `china_demand_clock` IS DELIBERATELY NOT IN THIS SET, EVEN THOUGH IT NOW READS LIVE DATA.
// It is a seasonal CLOCK: the question "has China shown up for U.S. new crop yet?" is worth putting
// in front of an analyst every year in the 1 Aug – 30 Sep window, and the answer is as newsworthy
// when it is "no" as when it is "yes". Gating it on the data being notable would silence the card in
// precisely the year China stays away — the year it matters most. The data belongs in the detail
// line, not in the firing condition. (See chinaClockDetail below.)
const DATA_TRIGGERS = new Set(["cot_managed_money_extreme", "pre_report_positioning", "harvest_strong_anomaly", "basis_carry_state"]);

// The stored market_series each trigger reads, colocated with dataFires()/describe() below so the two
// can't drift. The snapshot relevance gate (pipeline.formatMarketSnapshot) uses this to keep any series
// an ACTIVE trigger depends on at full detail. Date-only seasonal triggers read no series and are
// absent on purpose; pre_report_positioning is calendar-only (reads the report schedule, not a series).
export const TRIGGER_SERIES = {
  cot_managed_money_extreme: ["cftc:soybeans:mm-net"],
  harvest_strong_anomaly: ["nass:us:stocks"],
  basis_carry_state: [], // needs a futures carry spread (CME blocked) — no series until a curve feed lands
  china_demand_clock: [
    "fas:soybeans:china:next-my-commitments",
    "fas:soybeans:china:commitments",
    "fas:soybeans:china:share",
    "agtransport:soy-net-export-sales", // the labelled all-destinations fallback chinaClockDetail degrades to
  ],
};

function dataFires(id, now, snap) {
  if (id === "cot_managed_money_extreme") {
    const s = snap.get("cftc:soybeans:mm-net");
    if (!s) return { ok: false };
    const flip = s.previous && Math.sign(s.latest.value) !== Math.sign(s.previous.value) && s.previous.value !== 0;
    const ok = s.percentile >= 90 || s.percentile <= 10 || flip;
    return { ok, detail: `Managed-money net ${round(s.latest.value)} contracts, ${s.percentile}th percentile${flip ? ", just flipped long/short" : ""} (CFTC, ${s.latest.period}).` };
  }
  if (id === "pre_report_positioning") {
    const next = nextImpactfulReport("very_high", 10, now);
    if (!next) return { ok: false };
    const days = Math.ceil((Date.parse(next.date + "T12:00:00Z") - now.getTime()) / 86400e3);
    return { ok: days >= 1 && days <= 5, detail: `${next.name} is ${days} day${days === 1 ? "" : "s"} out (${next.date}).` };
  }
  if (id === "harvest_strong_anomaly") {
    // Date-gated to Sep–Nov already; proxy the "tight balance sheet" leg with low stocks percentile.
    const stocks = snap.get("nass:us:stocks");
    return { ok: stocks ? stocks.percentile <= 35 : false, detail: stocks ? `U.S. stocks at the ${stocks.percentile}th percentile — a tighter balance sheet.` : "" };
  }
  if (id === "basis_carry_state") {
    return { ok: false, detail: "" }; // needs a futures carry spread (CME blocked) — off until a futures feed lands
  }
  return { ok: true };
}

/** Millions of tonnes, for numbers that run to eight digits. Zero reads as a word, not as "0.00M t":
 *  "China has bought nothing" is the single most consequential state this card reports and it should
 *  not have to be decoded from a rounded decimal. */
const mmt = (v) => (v === 0 ? "nothing" : `${(v / 1e6).toFixed(2)}M t`);

/** Percentages, for the share series and its norm. */
const pct = (v) => `${Math.round(v)}%`;

/**
 * "vs. a year ago", stated so that BOTH ends of the comparison survive.
 *
 * ⚠️ THE TWO ZERO CASES ARE WHY THIS IS NOT A ONE-LINE PERCENTAGE, and neither is hypothetical:
 *
 *   - BASELINE ZERO. China's next-marketing-year book was exactly 0 on 2025-07-31 and 3,111,000 t on
 *     2026-07-30. A percentage change from zero is undefined, not infinite; `marketSnapshot`
 *     correctly returns `yoyPct: null`, and a caller that renders only percentages silently drops the
 *     most interesting comparison on the card.
 *   - CURRENT ZERO. If China has bought nothing, `yoyPct` is a perfectly well-formed -100% — and
 *     "-100%" alone tells you the direction while hiding the SCALE of what is missing. Against 1.5M t
 *     and against 22.5M t are very different absences, so the prior year's absolute is always shown.
 *     This case is checked BEFORE the percentage branch precisely because a valid percentage would
 *     otherwise mask it.
 */
function vsYearAgo(s, fmt = round) {
  if (!s?.yearAgo) return "";
  const prior = s.yearAgo.value;
  const now = s.latest.value;
  if (now === 0 && prior !== 0) return `none at all, against ${fmt(prior)} a year ago`;
  if (prior === 0 && now !== 0) return `against none at all a year ago`;
  if (s.yoyPct != null) return `${s.yoyPct >= 0 ? "+" : ""}${s.yoyPct.toFixed(0)}% vs. a year ago`;
  return `${fmt(prior)} a year ago`;
}

/**
 * "vs. the norm for this point in the year" — the anchor that a single prior year cannot provide.
 *
 * ⚠️ THIS EXISTS BECAUSE THE YEAR-AGO COMPARISON WAS ITSELF MISLEADING, MEASURED. China's
 * next-marketing-year book was exactly ZERO on 2025-07-31, so the honest year-on-year line reads
 * "against none at all a year ago" — which sounds extraordinary. Against the seven-year norm for the
 * same weeks it is 3.11M t versus 2.71M t: **+15%, 71st percentile**. Good, and thoroughly ordinary.
 * The anomaly was last year, not this year. A card built only on year-on-year has no way to know
 * which of the two years is the strange one, and will periodically make exactly that mistake.
 *
 * ⚠️ THE SAMPLE SIZE IS ALWAYS STATED. `seasonalYears` is exposed by `marketSnapshot` precisely so a
 * three-year norm is not read like a nine-year one, and a prior release shipped a live-wrong
 * seasonal read built from a single year. Below five years this says so in the text rather than
 * presenting a thin average as settled.
 *
 * `marketSnapshot` computes the norm from the SAME CALENDAR MONTH as the latest point across all
 * prior years, requiring at least 3 points spanning at least 3 distinct years, and returns nulls
 * otherwise — which routes this back to the year-on-year fallback rather than inventing a baseline.
 * Anchoring on the data's own period (late July here) rather than on today's date is what makes the
 * comparison like-for-like even though the trigger fires in August.
 */
function vsSeasonal(s, fmt = round) {
  if (s?.seasonalAvg == null || s.seasonalPctile == null) return "";
  const delta =
    s.seasonalDeltaPct != null
      ? `${s.seasonalDeltaPct >= 0 ? "+" : ""}${s.seasonalDeltaPct.toFixed(0)}% vs. the ${fmt(s.seasonalAvg)} norm for this week`
      : `against a ${fmt(s.seasonalAvg)} norm for this week`;
  // The sample size is stated ONCE for the whole line rather than three times — see chinaClockDetail.
  return `${delta} (${ordinal(s.seasonalPctile)} pctile)`;
}

/** 1st / 2nd / 3rd / 11th / 21st / 61st. A bare "th" produced "61th" on the first live render. */
function ordinal(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return String(n);
  const mod100 = v % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${v}th`;
  return `${v}${["th", "st", "nd", "rd"][v % 10] ?? "th"}`;
}

/**
 * Seasonal first, year-on-year second — and year-on-year is dropped entirely once the norm is
 * available and the two agree, to keep the line readable. It is KEPT when they disagree in
 * direction, because that disagreement is itself the finding: it means one of the two years is
 * unusual, which is exactly what a reader needs told rather than hidden.
 */
function context(s, fmt = round) {
  const seasonal = vsSeasonal(s, fmt);
  const yoy = vsYearAgo(s, fmt);
  if (!seasonal) return yoy;
  if (!yoy) return seasonal;
  const seasonalUp = (s.seasonalDeltaPct ?? 0) >= 0;
  const yoyUp = s.yoyPct != null ? s.yoyPct >= 0 : s.latest.value >= (s.yearAgo?.value ?? 0);
  return seasonalUp === yoyUp ? seasonal : `${seasonal}; but ${yoy}`;
}

/**
 * The China sourcing clock's data line.
 *
 * ⚠️ THIS TRIGGER WAS REPORTING A NUMBER THAT WAS NOT ABOUT CHINA. It read
 * `agtransport:soy-net-export-sales`, which is `sum(netsalescmy)` across ALL destinations — so on a
 * card whose entire purpose is "has China shown up for U.S. new crop yet?", it printed the world
 * total. Measured on the real feed on 2026-08-10 with the trigger firing: it said weekly net export
 * sales were **+10% vs. a year ago**, while China's own commitments were **−44.7%** (12.43M t against
 * 22.48M t) and China's share of the U.S. book had fallen from 43.7% to 29.8%. An analyst reading
 * that card would have concluded Chinese demand was fine.
 *
 * ⚠️ AND IT FIRES IN THE ONE WINDOW WHERE CURRENT-YEAR NUMBERS LIE. The window is 1 Aug – 30 Sep,
 * which straddles the soybean marketing-year rollover (31 Aug). Old-crop business is finishing by
 * definition, so a current-marketing-year figure trends to zero for calendar reasons that have
 * nothing to do with demand — while the new crop is being booked in a different field entirely. Both
 * legs are therefore reported, because in this window neither one alone is the answer:
 *
 *   - OLD CROP: China's commitments for the marketing year now ending, and their share of the book.
 *   - NEW CROP: China's outstanding sales for the marketing year about to begin — the live number.
 *
 * On the real data those two legs point in OPPOSITE directions right now (old crop −44.7%, new crop
 * 3.11M t against zero a year ago), which is exactly why collapsing this to one number — whichever
 * number — would misinform. See the header of adapters/fas_export_sales.js for the blind spot.
 */
function chinaClockDetail(snap) {
  const commitments = snap.get("fas:soybeans:china:commitments");
  const nextBook = snap.get("fas:soybeans:china:next-my-commitments");
  const share = snap.get("fas:soybeans:china:share");

  // `share` counts here too: it is the most informative of the three on its own, and falling through
  // to the all-destinations proxy while a real China ratio sat in the store would reintroduce exactly
  // the defect this function was written to remove.
  if (commitments || nextBook || share) {
    const parts = [];
    if (nextBook?.latest) {
      parts.push(
        nextBook.latest.value === 0
          ? `China has bought NO U.S. new-crop soybeans — ${context(nextBook, mmt)}`
          : `China has ${mmt(nextBook.latest.value)} of U.S. new-crop soybeans booked — ${context(nextBook, mmt)}`
      );
    }
    if (commitments?.latest) {
      parts.push(`old-crop commitments ${mmt(commitments.latest.value)} — ${context(commitments, mmt)}`);
    }
    if (share?.latest) {
      // Share is the cleanest of the three: a ratio, so it is immune to the cumulative reset that
      // makes the commitments series a sawtooth, and directly comparable across marketing years.
      parts.push(`China is ${share.latest.value}% of all U.S. soybean commitments — ${context(share, pct)}`);
    }

    // ⚠️ THE SAMPLE SIZE IS STATED ONCE, AND IT IS THE SMALLEST OF THE THREE. Repeating "8 years"
    // after every clause was unreadable, but dropping it entirely is not an option: a prior release
    // shipped a live-wrong seasonal read built from a single year, which is why `marketSnapshot`
    // exposes `seasonalYears` at all. Taking the MINIMUM means the caveat can never overstate how
    // much history the weakest leg of the line actually rests on.
    // ⚠️ COUNT ONLY THE LEGS THAT ACTUALLY CONTRIBUTED A NORM. `seasonalYears` is populated whenever
    // there is ANY same-month history, including the 1- and 2-year cases where `marketSnapshot`
    // deliberately refuses to compute an average — so filtering on it alone printed
    // "Norms are same-week averages over only 2 years" onto a line that contained no norm at all.
    // A footnote describing a calculation that did not happen is worse than no footnote.
    const spans = [nextBook, commitments, share].filter((s) => s?.seasonalAvg != null && s.seasonalYears).map((s) => s.seasonalYears);
    const years = spans.length ? Math.min(...spans) : 0;
    const normNote = years
      ? years < 5
        ? ` Norms are same-week averages over only ${years} years — thin, treat as indicative.`
        : ` Norms are same-week averages over ${years} years.`
      : "";

    const asOf = (nextBook ?? commitments ?? share).latest.period;
    return `${parts.join("; ")}.${normNote} USDA FAS Export Sales, week ending ${asOf}.`;
  }

  // FAS not populated (no FAS_API_KEY, or the first refresh has not run). Degrade to the old proxy,
  // but SAY WHAT IT IS. Presenting an all-destinations total unlabelled on a China card is the
  // defect this function exists to fix; an honest proxy is fine, a mislabelled one is not.
  const es = snap.get("agtransport:soy-net-export-sales");
  if (!es?.latest) return "";
  return (
    `No China-specific export-sales data available (set FAS_API_KEY to enable it). ` +
    `ALL-DESTINATIONS weekly net sales ${round(es.latest.value)} MT (${es.latest.period})` +
    `${es.yoyPct != null ? `, ${es.yoyPct >= 0 ? "+" : ""}${es.yoyPct.toFixed(0)}% vs. a year ago` : ""} — ` +
    `this is the world total and says nothing about China's share of it.`
  );
}

function describe(id, snap) {
  if (id === "china_demand_clock") return chinaClockDetail(snap);
  return "";
}

/**
 * Evaluate all condition triggers for `now`. Returns the fired triggers, ranked (lowest priority
 * number first), after applying each trigger's suppress_if (so the harvest-strong guardrail
 * softens its seasonal cards).
 * @returns {{ id, name, category, card_type, priority, history_note, detail }[]}
 */
export function evaluateTriggers(now = new Date()) {
  const cfg = load();
  const snap = new Map(store.marketSnapshot().map((s) => [s.series, s]));
  const fired = [];
  for (const t of cfg.triggers) {
    const win = dateWindow(t.fire_when?.expression, now);
    if (win === false) continue; // has a date window and we're outside it
    let detail = describe(t.id, snap);
    if (DATA_TRIGGERS.has(t.id)) {
      const d = dataFires(t.id, now, snap);
      if (!d.ok) continue;
      detail = d.detail || detail;
    }
    fired.push({ id: t.id, name: t.name, category: t.category, card_type: t.card_type, priority: t.priority ?? 5, history_note: t.history_note, suppress_if: t.suppress_if || [], detail });
  }
  const activeIds = new Set(fired.map((f) => f.id));
  return fired
    .filter((f) => !f.suppress_if.some((s) => activeIds.has(s)))
    .sort((a, b) => a.priority - b.priority)
    .map(({ suppress_if, ...rest }) => rest); // drop the internal field
}

/** Compact text of the fired triggers for the card-synthesis + Pulse prompts. */
export function triggersText(now = new Date()) {
  const fired = evaluateTriggers(now);
  if (!fired.length) return "";
  return fired
    .map((f) => `- [${f.card_type}, priority ${f.priority}] ${f.name}: ${f.history_note}${f.detail ? ` (current data: ${f.detail})` : ""}`)
    .join("\n");
}

/**
 * The market_series that CURRENTLY-fired triggers depend on — the trigger half of the snapshot
 * relevance gate's "referenced" set. A series here is one an active condition card is keying on right
 * now, so it earns full detail regardless of whether it happens to be moving.
 */
export function firedTriggerSeries(now = new Date()) {
  const out = new Set();
  for (const f of evaluateTriggers(now)) for (const s of TRIGGER_SERIES[f.id] ?? []) out.add(s);
  return out;
}
