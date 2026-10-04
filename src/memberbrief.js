// memberbrief.js — the ISA Member Brief (edition `member`): Monday, Wednesday, Friday, for farmer-members.
//
// Policy and regulatory first, markets second. Education, not advice. It goes out under ISA's name, so
// the design goal is that an unsupported claim is STRUCTURALLY hard, not merely discouraged:
//
//   1. NUMBERS ARE INSERTED BY CODE. Market figures are computed here from stored series and handed to
//      the model as locked tokens ({{FUND_SOYBEANS_NET}}); the renderer substitutes them. The lint
//      (policylint.lintMemberDraft) rejects any digit the model writes that is not inside a token or
//      verbatim in a source the sentence cites.
//   2. EVERY SENTENCE CITES. Each model sentence is { text, cites[] }, and every cite must resolve to a
//      stored record in the evidence packet: a URL, publisher, date and provenance tier.
//   3. CERTAINTY BANDS ARE CODE-RENDERED from the policy card (In force / Under challenge / Proposed —
//      NOT final / Signalled). The model never writes a band, and decision language on a proposed
//      action fails the lint.
//   4. ADVERSARIAL REVIEW. REVIEW_MODEL (default ANALYST_MODEL) checks the draft against the packet ONLY
//      (no web search) and may DELETE a sentence or DOWNGRADE a band — never add.
//   5. STALENESS. Every datum carries its "as of" date. A datum past its allowance is shown with its
//      date and marked "not updated this cycle", or omitted when it is older than twice the allowance.
//   6. FAIL CLOSED. If lint or review still fails after one retry, nothing is sent. The draft is saved
//      as <date>-member-draft.md, an alert is raised, and the reason is logged and stored on the run.
//
// "What to watch", the open comment deadlines, the market fact lines and the Sources list are rendered
// by code with no model involvement at all. The model writes only the update (≤ 3 sentences, enforced by
// code), the four sentences per policy item, and at most two explanatory sentences per market section.

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

import * as store from "./store.js";
import * as budget from "./budget.js";
import { gradeEvidence } from "./provenance.js";
import { lintMemberDraft, splitSentences } from "./policylint.js";
import { scanBanned, EDUCATION_FOOTER } from "./compliance.js";
import { oilSharePoints } from "./crush.js";
import { upcomingReports, upcomingPolicyEvents } from "./calendar.js";
import { parseDaySpec, localClock, DAYS } from "./schedule.js";
import { MARKETS as CFTC_MARKETS, SOURCE_URL as CFTC_URL } from "./adapters/cftc.js";
import { saveBrief, sendMemberBriefEmail, sendOpsAlert } from "./deliver.js";
import { wasTruncated } from "./modelcfg.js";
import { voice, seriesKey } from "./pack.js";
// State/org wording comes from the active state pack (docs/MULTI_STATE.md) — no state literals here.
const V = voice();

export const DEFAULT_MEMBER_SPEC = "Mon,Wed,Fri 06:45";
export const LAST_SENT_KEY = "member_brief:last_sent";
const MAX_POLICY_ITEMS = 8;
const MAX_UPDATE_SENTENCES = 3;
const MAX_MARKET_SENTENCES = 2;
const DAY_MS = 86400e3;

// ───────────────────────────────────────────────────────────────── formatting (code owns every number)

const MON = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
const MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-09-30" → "Sept. 30, 2026" (AP style); "2026-09" → "September 2026". */
export function fmtDate(iso) {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (!m) return String(iso ?? "");
  if (!m[3]) return `${MONTH_FULL[Number(m[2]) - 1]} ${m[1]}`;
  return `${MON[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}
const fmtInt = (v) => Math.round(Math.abs(v)).toLocaleString("en-US");
const fmt2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};
const daysBetween = (aISO, bISO) => Math.round((Date.parse(`${String(bISO).slice(0, 10)}T00:00:00Z`) - Date.parse(`${String(aISO).slice(0, 10)}T00:00:00Z`)) / DAY_MS);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (iso) => DAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()];

/** The UTC instant of local midnight on `dateISO` in `tz` (DST-correct). */
export function localMidnightUtc(dateISO, tz) {
  const [y, mo, d] = dateISO.split("-").map(Number);
  let guess = Date.UTC(y, mo - 1, d, 0, 0, 0);
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
        .formatToParts(new Date(guess))
        .map((p) => [p.type, p.value])
    );
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    guess -= asUtc - Date.UTC(y, mo - 1, d, 0, 0, 0);
  }
  return new Date(guess);
}

// ───────────────────────────────────────────────────────────────── the lookback window

/**
 * Since the previous Member Brief. Mon covers Fri–Sun, Wed covers Mon–Tue, Fri covers Wed–Thu: the window
 * runs from local midnight of the previous scheduled day to local midnight today, so nothing is
 * double-reported or skipped. If the last SENT edition ended earlier (an edition failed closed), the
 * window reaches back to where it ended, so a missed edition's items are not lost.
 */
export function memberWindow({ now = new Date(), tz = V.tz, spec = DEFAULT_MEMBER_SPEC, lastSent = null } = {}) {
  const days = parseDaySpec(spec)?.days ?? ["Mon", "Wed", "Fri"];
  const today = localClock(now, tz).date;
  let prev = addDays(today, -7);
  for (let i = 1; i <= 7; i++) {
    const d = addDays(today, -i);
    if (days.includes(weekdayOf(d))) {
      prev = d;
      break;
    }
  }
  let next = addDays(today, 7);
  for (let i = 1; i <= 7; i++) {
    const d = addDays(today, i);
    if (days.includes(weekdayOf(d))) {
      next = d;
      break;
    }
  }
  const end = localMidnightUtc(today, tz);
  let start = localMidnightUtc(prev, tz);
  const last = lastSent?.windowEnd ? new Date(lastSent.windowEnd) : null;
  if (last && last < start && last > new Date(now.getTime() - 14 * DAY_MS)) start = last;
  return { startISO: start.toISOString(), endISO: end.toISOString(), fromDate: localClock(start, tz).date, toDate: addDays(today, -1), today, nextEdition: next };
}

// ───────────────────────────────────────────────────────────────── the evidence packet

const PUBLISHER = {
  federal_register: "Federal Register",
  regulations_gov: "Regulations.gov",
  congress_gov: "Congress.gov",
  congress_hearings: "Congress.gov (committee hearings)",
  legiscan: "LegiScan (state legislative record)",
  courtlistener: "CourtListener (federal court dockets)",
  eurlex_oj: "EUR-Lex (Official Journal of the EU)",
  iowa_admin_rules: "Iowa Administrative Bulletin",
};
const BAND = {
  enacted: { label: "In force", caveat: "Final and in effect." },
  contested: { label: "In force — under legal challenge", caveat: "Binding today, but in litigation; it may not survive." },
  proposed: { label: "Proposed — NOT final", caveat: "Published but not in effect. It may change substantially or never take effect." },
  speculative: { label: "Signalled — not yet an action", caveat: "Reported or expected. Nothing has been published and there is no deadline yet." },
};
export const BAND_ORDER = ["enacted", "contested", "proposed", "speculative"];

/** Builder for the packet: ids are assigned in insertion order and never reused within one brief. */
function newPacket(window) {
  const sources = new Map(); // id → { id, kind, title, publisher, url, date, tier, text }
  let n = 0;
  return {
    window,
    sources,
    tokens: new Map(), // NAME → { value, stale }
    policy: new Map(), // P1 → { id, band, card, citeIds:Set, … }
    markets: new Map(), // fund | oilShare | ratio | barge → { label, lines[], citeIds:Set, status }
    deadlines: [],
    watch: [],
    addSource(rec) {
      const dup = [...sources.values()].find((s) => s.url && s.url === rec.url && s.title === rec.title);
      if (dup) return dup.id;
      const id = `S${++n}`;
      sources.set(id, { id, ...rec });
      return id;
    },
    token(name, value, stale = false) {
      this.tokens.set(name, { value: String(value), stale });
      return `{{${name}}}`;
    },
  };
}

function itemSource(pk, uid, fallback = {}) {
  const it = store.getItemForCitation(uid) ?? {};
  const url = it.url || fallback.url || "";
  const g = gradeEvidence({ sourceId: it.source_id, url });
  return pk.addSource({
    kind: "item",
    title: it.title || fallback.title || "(untitled)",
    publisher: PUBLISHER[it.source_id] ?? (g.advocacy ? `${hostLabel(url)} (interested party)` : hostLabel(url)),
    url,
    date: String(it.published_at || it.first_seen_at || "").slice(0, 10),
    tier: g.grade,
    tierLabel: g.label + (g.advocacy ? ", interested party" : ""),
    // The text a sentence may quote an identifier from (bill number, rule name) — title, the triage
    // one-liner, and the stored document/article text.
    text: [it.title, it.one_line, it.body].filter(Boolean).join(" \n ").slice(0, 6000),
  });
}
const hostLabel = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
};

/** Policy items: the published policy cards in the window, ranked by band then clock date. */
function addPolicy(pk) {
  const rows = store.keptCardsBetween(pk.window.startISO, pk.window.endISO);
  const ranked = rows
    .filter((r) => BAND[r.certainty])
    .sort((a, b) => BAND_ORDER.indexOf(a.certainty) - BAND_ORDER.indexOf(b.certainty) || String(a.card?.posture?.clock_date || "9999").localeCompare(String(b.card?.posture?.clock_date || "9999")))
    .slice(0, MAX_POLICY_ITEMS);
  ranked.forEach((r, i) => {
    const id = `P${i + 1}`;
    const items = (r.card?.evidence ?? []).filter((e) => e.kind === "item");
    const citeIds = new Set(items.map((e) => itemSource(pk, e.key, { url: e.url, title: e.title })));
    const clock = r.card?.posture?.clock_date;
    const next = r.card?.watch_next?.date;
    const tokens = {};
    if (/^\d{4}-\d{2}(-\d{2})?$/.test(clock ?? "")) tokens.clock = pk.token(`${id}_CLOCK`, fmtDate(clock));
    if (/^\d{4}-\d{2}(-\d{2})?$/.test(next ?? "")) tokens.next = pk.token(`${id}_NEXT_DATE`, fmtDate(next));
    pk.policy.set(id, {
      id,
      band: r.certainty,
      eventKey: r.event_key,
      headline: r.card?.headline ?? "",
      card: r.card,
      citeIds,
      tokens,
      clockLabel: r.card?.posture?.clock_label ?? "",
    });
  });
}

/** Open comment deadlines — code-rendered, prominent, repeated until they close. */
function addDeadlines(pk) {
  const today = pk.window.today;
  for (const d of store.upcomingDeadlines(12)) {
    const date = String(d.comment_deadline ?? "").slice(0, 10);
    if (!date || date < today) continue;
    pk.deadlines.push({ date, title: d.title, url: d.url, cite: itemSource(pk, d.uid, { url: d.url, title: d.title }) });
  }
}

// ── market facts ──────────────────────────────────────────────────────────────────────────────────

const series = (key) => {
  try {
    return store.getSeries(key) ?? [];
  } catch {
    return [];
  }
};
/** The newest point at or before `iso` (points ascending). */
const atOrBefore = (pts, iso) => {
  let best = null;
  for (const p of pts) if (p.period <= iso) best = p;
  return best;
};

/**
 * The CFTC "as of" date the latest release should carry. COT is released Friday 2:30 p.m. ET for positions
 * as of the prior Tuesday; before that time on Friday, last week's Tuesday is the newest available.
 */
export function expectedCotAsOf(now = new Date()) {
  const etParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  const etDate = `${etParts.year}-${etParts.month}-${etParts.day}`;
  const dow = DAYS.indexOf(etParts.weekday);
  const minutes = Number(etParts.hour) * 60 + Number(etParts.minute);
  // Days back to the most recent Friday whose 14:30 release has happened.
  let back = (dow - 5 + 7) % 7;
  if (back === 0 && minutes < 14 * 60 + 30) back = 7;
  return addDays(addDays(etDate, -back), -3); // that Friday's Tuesday
}

/** Staleness: ok within the allowance; shown-with-date up to 2×; omitted beyond. */
function freshness(asOf, today, allowDays) {
  if (!asOf) return "absent";
  const age = daysBetween(asOf, today);
  if (age <= allowDays) return "current";
  if (age <= allowDays * 2) return "stale_shown";
  return "stale_omitted";
}

function addFund(pk, now) {
  const fact = { label: "Fund positioning (CFTC, managed money)", lines: [], citeIds: new Set(), status: "absent" };
  const expected = expectedCotAsOf(now);
  for (const m of CFTC_MARKETS) {
    const pts = series(`cftc:${m.key}:mm-net`);
    if (pts.length < 2) {
      fact.lines.push(`${m.label}: not available this cycle.`);
      continue;
    }
    const latest = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    const window = pts.slice(-52).map((p) => p.value);
    const pct = Math.round((window.filter((v) => v <= latest.value).length / window.length) * 100);
    // Allowance: the expected Tuesday, i.e. age ≤ (today − expected). Shown-with-date when one release behind.
    const lag = daysBetween(latest.period, expected);
    const state = lag <= 0 ? "current" : lag <= 7 ? "stale_shown" : "stale_omitted";
    const K = `FUND_${m.key.toUpperCase()}`;
    const cite = pk.addSource({
      kind: "series",
      title: `CFTC Commitments of Traders (disaggregated, futures only) — ${m.label}, managed money`,
      publisher: "U.S. Commodity Futures Trading Commission",
      url: CFTC_URL,
      date: latest.period,
      tier: "primary_source",
      tierLabel: "primary source",
      text: `${m.label} managed money net ${latest.value} contracts, week ending ${latest.period}`,
    });
    if (state === "stale_omitted") {
      fact.lines.push(`${m.label}: not updated this cycle (latest available is for the week ending ${fmtDate(latest.period)}).`);
      for (const t of ["NET", "WOW", "PCT52", "ASOF"]) pk.token(`${K}_${t}`, "", true);
      continue;
    }
    fact.citeIds.add(cite);
    const net = pk.token(`${K}_NET`, `${latest.value >= 0 ? "net long" : "net short"} ${fmtInt(latest.value)} contracts`);
    const d = latest.value - prev.value;
    const wow = pk.token(`${K}_WOW`, d === 0 ? "unchanged from the prior week" : `${d > 0 ? "up" : "down"} ${fmtInt(d)} contracts from the prior week`);
    const p52 = pk.token(`${K}_PCT52`, `${ordinal(pct)} percentile of the past 52 weeks`);
    const asof = pk.token(`${K}_ASOF`, `week ending ${fmtDate(latest.period)}`);
    fact.lines.push(`${m.label}: ${net}, ${wow}; ${p52} (${asof})${state === "stale_shown" ? " — not updated this cycle" : ""} [${cite}]`);
    fact.status = fact.status === "current" || state === "current" ? "current" : "stale_shown";
  }
  pk.markets.set("fund", fact);
}

function addOilShare(pk) {
  const fact = { label: "Oil share of crush", lines: [], citeIds: new Set(), status: "absent" };
  const today = pk.window.today;
  // Member-facing: CME settlements first, then USDA AMS Iowa cash. Never the Yahoo board legs.
  const candidates = [
    {
      basis: "CME Group settlement prices, most-active soybean oil and soybean meal futures",
      meal: series("cme:zm:front"),
      oil: series("cme:zl:front"),
      allow: 4,
      source: { title: "CME Group daily settlements — soybean oil (ZL) and soybean meal (ZM)", publisher: "CME Group", url: "https://www.cmegroup.com/markets/agriculture/oilseeds/soybean-oil.settlements.html", tier: "primary_source", tierLabel: "exchange of record" },
    },
    {
      basis: `${V.state} cash soybean oil and meal, USDA AMS National Grain & Oilseed Processor Feedstuff report`,
      meal: series(seriesKey("ams", "meal")),
      oil: series(seriesKey("ams", "oil")),
      allow: 10,
      source: { title: `USDA AMS National Grain and Oilseed Processor Feedstuff report (3511) — ${V.state} soybean oil and meal`, publisher: "USDA Agricultural Marketing Service", url: "https://mymarketnews.ams.usda.gov/viewReport/3511", tier: "primary_source", tierLabel: "primary source" },
    },
  ];
  for (const c of candidates) {
    const pts = oilSharePoints(c.meal, c.oil);
    if (!pts.length) continue;
    const latest = pts[pts.length - 1];
    const state = freshness(latest.period, today, c.allow);
    if (state === "stale_omitted") continue; // try the next basis
    const prior = atOrBefore(pts, addDays(latest.period, -7));
    const cite = pk.addSource({ kind: "series", ...c.source, date: latest.period, text: `oil share ${latest.value}% as of ${latest.period}` });
    fact.citeIds.add(cite);
    const share = pk.token("OILSHARE_PCT", `${latest.value.toFixed(1)}%`);
    const chg = prior ? latest.value - prior.value : null;
    const wow = pk.token("OILSHARE_WOW", chg == null ? "no comparable reading a week earlier" : Math.abs(chg) < 0.05 ? "unchanged from a week earlier" : `${chg > 0 ? "up" : "down"} ${Math.abs(chg).toFixed(1)} percentage points from a week earlier`);
    const asof = pk.token("OILSHARE_ASOF", fmtDate(latest.period));
    pk.token("OILSHARE_BASIS", c.basis);
    fact.lines.push(`Soybean oil's share of crush product value: ${share}, ${wow} (as of ${asof}; ${c.basis})${state === "stale_shown" ? " — not updated this cycle" : ""} [${cite}]`);
    fact.status = state;
    break;
  }
  if (fact.status === "absent") {
    fact.lines.push("Not updated this cycle — no current CME or USDA AMS price pair is stored.");
    for (const t of ["PCT", "WOW", "ASOF", "BASIS"]) if (!pk.tokens.has(`OILSHARE_${t}`)) pk.token(`OILSHARE_${t}`, "", true);
  }
  pk.markets.set("oilShare", fact);
}

/** The nearest new-crop pair with both contracts stored: Nov soybeans ÷ Dec corn of the same year. */
export function newCropRatio(today, get = series) {
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    // A November contract is gone after its mid-November expiry; roll to next year's pair.
    if (`${y}-11-14` < today) continue;
    const zs = get(`cme:zs:${y}-11`);
    const zc = get(`cme:zc:${y}-12`);
    const corn = new Map(zc.map((p) => [p.period, p.value]));
    const pts = zs.filter((p) => corn.get(p.period) > 0).map((p) => ({ period: p.period, value: p.value / corn.get(p.period) }));
    if (pts.length) return { year: y, latest: pts[pts.length - 1], points: pts };
  }
  return null;
}

function addRatio(pk) {
  const fact = { label: "Soybean:corn price ratio", lines: [], citeIds: new Set(), status: "absent" };
  const today = pk.window.today;
  const nc = newCropRatio(today);
  if (nc) {
    const state = freshness(nc.latest.period, today, 4);
    if (state !== "stale_omitted") {
      const cite = pk.addSource({ kind: "series", title: `CME Group daily settlements — November ${nc.year} soybeans (ZS) and December ${nc.year} corn (ZC)`, publisher: "CME Group", url: "https://www.cmegroup.com/markets/agriculture/oilseeds/soybean.settlements.html", date: nc.latest.period, tier: "primary_source", tierLabel: "exchange of record", text: `ratio ${fmt2(nc.latest.value)} on ${nc.latest.period}` });
      fact.citeIds.add(cite);
      const v = pk.token("RATIO_NEWCROP", fmt2(nc.latest.value));
      const k = pk.token("RATIO_CONTRACTS", `November ${nc.year} soybeans ÷ December ${nc.year} corn futures`);
      const a = pk.token("RATIO_ASOF", `settlement of ${fmtDate(nc.latest.period)}`);
      fact.lines.push(`New-crop ratio, ${k}: ${v} (${a})${state === "stale_shown" ? " — not updated this cycle" : ""} [${cite}]`);
      fact.status = state;
    }
  }
  if (fact.status === "absent") {
    fact.lines.push("New-crop futures ratio: not updated this cycle (no current November soybean / December corn settlement pair is stored).");
    for (const t of ["NEWCROP", "CONTRACTS", "ASOF"]) pk.token(`RATIO_${t}`, "", true);
  }
  // Context, always dated: NASS Iowa prices received (monthly, published with a lag).
  const ia = series(seriesKey("nass", "soy-corn-ratio"));
  if (ia.length) {
    const l = ia[ia.length - 1];
    const cite = pk.addSource({ kind: "series", title: `USDA NASS Agricultural Prices — ${V.state} soybean and corn prices received`, publisher: "USDA National Agricultural Statistics Service", url: "https://quickstats.nass.usda.gov/", date: l.period, tier: "primary_source", tierLabel: "primary source", text: `${V.state} ratio ${fmt2(l.value)} for ${l.period}` });
    fact.citeIds.add(cite);
    const v = pk.token("RATIO_IOWA_MONTHLY", fmt2(l.value));
    const p = pk.token("RATIO_IOWA_PERIOD", fmtDate(l.period));
    fact.lines.push(`Context — ${V.state} prices received (monthly, published with a lag): ${v} for ${p} [${cite}]`);
    if (fact.status === "absent") fact.status = "context_only";
  }
  pk.markets.set("ratio", fact);
}

/** Same week in the prior three years: the nearest point within ±7 days of the same date, per year. */
export function threeYearAverage(pts, period) {
  const vals = [];
  for (let k = 1; k <= 3; k++) {
    const target = `${Number(period.slice(0, 4)) - k}${period.slice(4)}`;
    let best = null;
    for (const p of pts) {
      const gap = Math.abs(daysBetween(p.period, target));
      if (gap <= 7 && (!best || gap < best.gap)) best = { gap, v: p.value };
    }
    if (best) vals.push(best.v);
  }
  return vals.length >= 2 ? { avg: vals.reduce((a, b) => a + b, 0) / vals.length, years: vals.length } : null;
}

function addBarge(pk) {
  const fact = { label: "Barge freight", lines: [], citeIds: new Set(), status: "absent" };
  const today = pk.window.today;
  const metas = store.listSeriesMeta("barge_freight").filter((m) => m.series.startsWith("agtransport:barge-freight:"));
  for (const m of metas) {
    const pts = series(m.series);
    if (!pts.length) continue;
    const latest = pts[pts.length - 1];
    const state = freshness(latest.period, today, 14);
    const place = String(m.label).replace(/^Barge freight — /, "");
    const slug = m.series.split(":").pop().replace(/[^a-z0-9]+/gi, "_").toUpperCase();
    if (state === "stale_omitted") {
      fact.lines.push(`${place}: not updated this cycle (latest available is ${fmtDate(latest.period)}).`);
      continue;
    }
    const cite = pk.addSource({ kind: "series", title: `USDA AMS Grain Transportation Report — downbound barge freight, ${place}`, publisher: "USDA Agricultural Marketing Service (Ag Transport)", url: "https://agtransport.usda.gov/d/7spn-fbua", date: latest.period, tier: "primary_source", tierLabel: "primary source", text: `${place} $${fmt2(latest.value)} per ton ${latest.period}` });
    fact.citeIds.add(cite);
    const prior = atOrBefore(pts, addDays(latest.period, -6));
    const rate = pk.token(`BARGE_${slug}_RATE`, `$${fmt2(latest.value)} per ton`);
    const chg = prior && prior.period !== latest.period ? latest.value - prior.value : null;
    const wow = pk.token(`BARGE_${slug}_WOW`, chg == null ? "no prior-week reading" : Math.abs(chg) < 0.005 ? "unchanged from the prior week" : `${chg > 0 ? "up" : "down"} $${fmt2(Math.abs(chg))} from the prior week`);
    const a3 = threeYearAverage(pts, latest.period);
    const avg = a3 ? pk.token(`BARGE_${slug}_AVG3`, `$${fmt2(a3.avg)} per ton ${a3.years === 3 ? "3-year" : `${a3.years}-year`} average for the same week`) : null;
    const asof = pk.token(`BARGE_${slug}_ASOF`, `week of ${fmtDate(latest.period)}`);
    fact.lines.push(`${place}: ${rate}, ${wow}${avg ? `; ${avg}` : ""} (${asof})${state === "stale_shown" ? " — not updated this cycle" : ""} [${cite}]`);
    fact.status = fact.status === "current" || state === "current" ? "current" : "stale_shown";
  }
  if (fact.status === "absent" && !fact.lines.length) fact.lines.push("Not updated this cycle — no location-level barge freight is stored yet.");
  pk.markets.set("barge", fact);
}

// ── what to watch (code only) ─────────────────────────────────────────────────────────────────────
const CAL_URL = {
  WASDE: "https://www.usda.gov/oce/commodity/wasde",
  EXPORT_SALES: "https://apps.fas.usda.gov/export-sales/esrd1.html",
  COT: CFTC_URL,
};
function addWatch(pk) {
  const from = pk.window.today;
  const to = pk.window.nextEdition;
  const span = daysBetween(from, to) + 1;
  const add = (date, text, src) => {
    if (date >= from && date <= to) pk.watch.push({ date, text, cite: pk.addSource(src) });
  };
  for (const r of upcomingReports(span, new Date(`${from}T00:00:00Z`))) {
    if (r.impact === "low" && r.type !== "COT") continue;
    add(r.date, `${r.name} (${r.agency})`, { kind: "calendar", title: `${r.agency} release calendar — ${r.name}`, publisher: r.agency, url: CAL_URL[r.type] ?? "https://www.nass.usda.gov/Publications/Calendar/index.php", date: r.date, tier: "agency_press", tierLabel: "agency release", text: `${r.name} ${r.date}` });
  }
  for (const e of upcomingPolicyEvents(span, new Date(`${from}T00:00:00Z`))) {
    add(e.date, e.name, { kind: "calendar", title: e.name, publisher: `${V.short} policy calendar (authored)`, url: "", date: e.date, tier: "aggregator", tierLabel: `${V.short}-authored calendar`, text: `${e.name} ${e.date}` });
  }
  for (const d of pk.deadlines) if (d.date <= to) pk.watch.push({ date: d.date, text: `Comments due: ${d.title}`, cite: d.cite });
  for (const h of store.upcomingHearings(40)) {
    const date = String(h.published_at ?? "").slice(0, 10);
    if (date >= from && date <= to) pk.watch.push({ date, text: `Hearing: ${h.title}`, cite: itemSource(pk, h.uid, { url: h.url, title: h.title }) });
  }
  for (const p of pk.policy.values()) {
    const d = String(p.card?.watch_next?.date ?? "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d >= from && d <= to) pk.watch.push({ date: d, text: `${p.card.watch_next.event} (${p.headline})`, cite: [...p.citeIds][0] });
  }
  pk.watch.sort((a, b) => a.date.localeCompare(b.date));
}

/** Assemble the whole evidence packet for one edition. Pure over the store; no network, no model. */
export function buildMemberPacket({ now = new Date(), tz = V.tz, spec = DEFAULT_MEMBER_SPEC, lastSent = null } = {}) {
  const window = memberWindow({ now, tz, spec, lastSent });
  const pk = newPacket(window);
  addPolicy(pk);
  addDeadlines(pk);
  addFund(pk, now);
  addOilShare(pk);
  addRatio(pk);
  addBarge(pk);
  addWatch(pk);
  return pk;
}

// ───────────────────────────────────────────────────────────────── the model stages

const SENTENCE = {
  type: "object",
  properties: {
    text: { type: "string", description: "ONE sentence. Any number, date or amount must be a {{TOKEN}} from the packet." },
    cites: { type: "array", items: { type: "string" }, description: "Source ids (S1, S2…) this sentence rests on. At least one." },
  },
  required: ["text", "cites"],
  additionalProperties: false,
};
export const MEMBER_SCHEMA = {
  type: "object",
  properties: {
    update: { type: "array", items: SENTENCE, description: "The update: 1 to 3 sentences, the most important things a member should know." },
    policy: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The policy item id (P1, P2…) exactly as given." },
          whatChanged: SENTENCE,
          whereItStands: SENTENCE,
          whatItMeans: SENTENCE,
          next: SENTENCE,
        },
        required: ["id", "whatChanged", "whereItStands", "whatItMeans", "next"],
        additionalProperties: false,
      },
    },
    markets: {
      type: "object",
      properties: { fund: { type: "array", items: SENTENCE }, oilShare: { type: "array", items: SENTENCE }, ratio: { type: "array", items: SENTENCE }, barge: { type: "array", items: SENTENCE } },
      required: ["fund", "oilShare", "ratio", "barge"],
      additionalProperties: false,
    },
  },
  required: ["update", "policy", "markets"],
  additionalProperties: false,
};

// ⚠️ STATIC — this is the cached prefix. Nothing that changes between editions may go in here.
export const MEMBER_SYSTEM = `You write the ${V.short} Member Brief: a short, plain-language update for ${V.org} farmer-members, sent Monday, Wednesday and Friday. Policy and regulatory news first, markets second. It is education, not advice.

You are given an EVIDENCE PACKET. It is the ONLY information you may use. You have no other knowledge for this task: no background facts, no prior news, no outside numbers.

HARD RULES — a draft that breaks any of these is rejected by code and not sent:
1. Every entry is EXACTLY ONE sentence, with "cites": the ids (S1, S2…) of the packet sources it rests on. A sentence with no cite is deleted.
2. NUMBERS. You never write a digit yourself. Every number, date, dollar amount, percentage, percentile or count must be written as a {{TOKEN}} from the packet, exactly as listed (e.g. {{FUND_SOYBEANS_NET}}). The only exception is an identifier that appears verbatim in a source you cite (a bill number like "HF 2571", a rule name like "45Z"). Tokens listed as WITHHELD must not be used.
3. CERTAINTY. Each policy item carries a band set by code: In force / In force — under legal challenge / Proposed — NOT final / Signalled — not yet an action. Write so the band is true. A Proposed or Signalled item is never described as decided: do not say final, in effect, requires, mandates, approved, or takes effect. Only an In-force item may be described as in effect.
4. SCOPE. A policy item's sentences may cite only that item's sources. A market section's sentences may cite only that section's sources.
5. EDUCATION, NOT ADVICE. Never tell a farmer to buy, sell, hold, store, price or hedge; never say now is a good or bad time; never predict prices. Explain what happened and what it means for ${V.aState} corn and soybean operation.
6. Plain words. Short sentences. No hype. No "we". Name the agency, court or legislature that acted.

WHAT TO WRITE
- "update": 1 to 3 sentences — the most important things since the last brief, policy first.
- "policy": for EACH policy item given, four sentences: whatChanged (who did what), whereItStands (procedural status, using the clock token if given), whatItMeans (the concrete consequence for ${V.aState} corn/soybean operation, as explanation), next (the next dated event, using the next-date token if given; if none, say the next step is not yet scheduled).
- "markets": for each of fund, oilShare, ratio, barge — 0 to 2 sentences explaining what the code-written figures mean. The figures themselves are already printed by code; do not repeat every number. If a section is marked not updated this cycle, write zero sentences for it.

If the packet is thin, write less. Fewer, fully supported sentences are always better than more.`;

export const REVIEW_SYSTEM = `You are the adversarial reviewer for the ${V.short} Member Brief, a member-facing publication of the ${V.org}. You check a DRAFT against its EVIDENCE PACKET and nothing else — you have no other knowledge for this task and no web access.

You may only REMOVE or DOWNGRADE. You may never add, rewrite or soften wording.

For every numbered sentence decide:
- "keep" — every claim in it is directly supported by the sources it cites, and nothing overstates certainty.
- "delete" — any claim is not supported by its cited sources, overstates certainty, reads as advice or a price prediction, or implies a decision that has not happened.
When in doubt, delete. A deleted sentence costs a little clarity; an unsupported sentence sent under ${V.short}'s name costs trust.

For every policy item decide its band:
- "keep" — the band matches what the cited sources establish.
- "downgrade" — the sources do not establish the band; give the band they DO support ("contested", "proposed" or "speculative"). You may never raise a band.

Give a one-line reason for every delete and downgrade.`;

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    sentences: {
      type: "array",
      items: {
        type: "object",
        properties: { sid: { type: "string" }, action: { type: "string", enum: ["keep", "delete"] }, reason: { type: "string" } },
        required: ["sid", "action", "reason"],
        additionalProperties: false,
      },
    },
    bands: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, action: { type: "string", enum: ["keep", "downgrade"] }, to: { type: "string", enum: ["contested", "proposed", "speculative", ""] }, reason: { type: "string" } },
        required: ["id", "action", "to", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["sentences", "bands"],
  additionalProperties: false,
};

/** The packet as the model sees it (user turn). Tokens show their VALUES so the model knows what each says. */
export function packetPrompt(pk) {
  const src = [...pk.sources.values()].map((s) => `${s.id} [${s.tierLabel ?? s.tier}] ${s.publisher} — ${s.title}${s.date ? ` (${s.date})` : ""}${s.text ? `\n    text: ${String(s.text).replace(/\s+/g, " ").slice(0, 1200)}` : ""}`);
  const toks = [...pk.tokens].map(([k, v]) => (v.stale ? `{{${k}}} — WITHHELD (not updated this cycle; do not use)` : `{{${k}}} = ${v.value}`));
  const pol = [...pk.policy.values()].map((p) => {
    const c = p.card ?? {};
    return [
      `${p.id} — band: ${BAND[p.band].label} — "${c.headline ?? ""}" — sources: ${[...p.citeIds].join(", ") || "(none)"}`,
      `    what changed (staff card): ${c.what_changed ?? ""}`,
      `    posture: ${c.posture?.status ?? ""}; ${c.posture?.detail ?? ""}${p.tokens.clock ? `; ${p.clockLabel || "date"} ${p.tokens.clock}` : ""}`,
      `    consequence (staff card): ${c.so_what ?? ""}`,
      `    next: ${c.watch_next?.event ?? ""}${p.tokens.next ? ` — ${p.tokens.next}` : ""}`,
    ].join("\n");
  });
  const mk = [...pk.markets].map(([k, f]) => `${k} — ${f.label} — status ${f.status} — sources: ${[...f.citeIds].join(", ") || "(none)"}\n${f.lines.map((l) => `    ${l}`).join("\n")}`);
  return [
    `EDITION: ${V.short} Member Brief for ${fmtDate(pk.window.today)}, covering ${fmtDate(pk.window.fromDate)} through ${fmtDate(pk.window.toDate)}.`,
    `\nSOURCES:\n${src.join("\n") || "(none)"}`,
    `\nTOKENS:\n${toks.join("\n") || "(none)"}`,
    `\nPOLICY ITEMS:\n${pol.join("\n\n") || "(none in this window)"}`,
    `\nMARKET SECTIONS (figures already printed by code):\n${mk.join("\n\n")}`,
  ].join("\n");
}

/** Code-side enforcement after every model stage: one-sentence entries, ≤ 3 update sentences, ≤ 2 per market. */
export function normalizeDraft(d) {
  const one = (s) => (s && typeof s.text === "string" ? { text: s.text.trim(), cites: Array.isArray(s.cites) ? s.cites.map(String) : [] } : null);
  const flat = (list) =>
    (list ?? []).flatMap((s) => {
      const o = one(s);
      if (!o) return [];
      // A multi-sentence entry is split; every piece keeps the entry's cites (each is then linted alone).
      return splitSentences(o.text).map((t) => ({ text: t, cites: o.cites }));
    });
  const markets = {};
  for (const k of ["fund", "oilShare", "ratio", "barge"]) markets[k] = flat(d?.markets?.[k]).slice(0, MAX_MARKET_SENTENCES);
  return {
    update: flat(d?.update).slice(0, MAX_UPDATE_SENTENCES), // ≤ 3 sentences, enforced by code
    policy: (d?.policy ?? []).filter((p) => p && p.id).map((p) => ({ id: p.id, whatChanged: one(p.whatChanged), whereItStands: one(p.whereItStands), whatItMeans: one(p.whatItMeans), next: one(p.next) })),
    markets,
  };
}

/**
 * Does the DRAFT cover every policy item in the packet — each exactly once, all four sentences present?
 * The schema cannot say "one entry per packet item", and the renderer skips an absent item silently, so
 * a draft that drops an action (or all of them) would otherwise pass. Checked on the draft only: after
 * review a deleted sentence is a legitimate gap. Returns lint-shaped failures ([] = complete).
 */
export function draftCompleteness(draft, pk) {
  const out = [];
  const n = new Map();
  for (const p of draft.policy) n.set(p.id, (n.get(p.id) ?? 0) + 1);
  for (const id of pk.policy.keys()) {
    const c = n.get(id) ?? 0;
    if (c !== 1) {
      out.push({ path: `policy.${id}`, rule: c ? "duplicate_policy_item" : "missing_policy_item", detail: c ? `${id} appears ${c} times — write it once` : `${id} is in the packet but not in the draft — every policy item gets all four sentences` });
      continue;
    }
    const p = draft.policy.find((x) => x.id === id);
    for (const slot of ["whatChanged", "whereItStands", "whatItMeans", "next"]) if (!p[slot]?.text) out.push({ path: `policy.${id}.${slot}`, rule: "missing_policy_sentence", detail: `${id} needs its ${slot} sentence` });
  }
  for (const id of n.keys()) if (!pk.policy.has(id)) out.push({ path: `policy.${id}`, rule: "unknown_policy_item", detail: `${id} is not a policy item in the packet` });
  return out;
}

/** Every sentence of a draft with a stable id, for the reviewer and for applying its decisions. */
export function sentenceList(draft) {
  const out = [];
  draft.update.forEach((s, i) => out.push({ sid: `U${i + 1}`, where: ["update", i], s }));
  for (const p of draft.policy) for (const slot of ["whatChanged", "whereItStands", "whatItMeans", "next"]) if (p[slot]) out.push({ sid: `${p.id}.${slot}`, where: ["policy", p.id, slot], s: p[slot] });
  for (const [k, list] of Object.entries(draft.markets)) list.forEach((s, i) => out.push({ sid: `M.${k}.${i + 1}`, where: ["markets", k, i], s }));
  return out;
}

/**
 * Did the reviewer actually review everything? Exactly one decision per draft sentence and per policy
 * band, and none for ids it was not shown. A sentence with no decision is NOT approved — an empty or
 * partial review must fail closed, not wave the draft through. Returns the problems ([] = complete).
 */
export function reviewCoverage(draft, review, pk) {
  const problems = [];
  const tally = (list, key) => {
    const m = new Map();
    for (const x of Array.isArray(list) ? list : []) m.set(x?.[key], (m.get(x?.[key]) ?? 0) + 1);
    return m;
  };
  const check = (kind, want, got) => {
    for (const id of want) {
      const n = got.get(id) ?? 0;
      if (n !== 1) problems.push(n ? `${n} decisions on ${kind} ${id}` : `no decision on ${kind} ${id}`);
    }
    for (const id of got.keys()) if (!want.includes(id)) problems.push(`decision on unknown ${kind} ${id}`);
  };
  check("sentence", sentenceList(draft).map((x) => x.sid), tally(review?.sentences, "sid"));
  check("band", [...pk.policy.keys()], tally(review?.bands, "id"));
  return problems;
}

/** Apply the reviewer's decisions. It can only delete sentences and lower bands — enforced here. */
export function applyReview(draft, review, pk) {
  const del = new Set((review?.sentences ?? []).filter((x) => x.action === "delete").map((x) => x.sid));
  const out = structuredClone(draft);
  out.update = out.update.filter((_, i) => !del.has(`U${i + 1}`));
  for (const p of out.policy) for (const slot of ["whatChanged", "whereItStands", "whatItMeans", "next"]) if (del.has(`${p.id}.${slot}`)) p[slot] = null;
  for (const k of Object.keys(out.markets)) out.markets[k] = out.markets[k].filter((_, i) => !del.has(`M.${k}.${i + 1}`));
  const downgrades = [];
  for (const b of review?.bands ?? []) {
    if (b.action !== "downgrade") continue;
    const item = pk.policy.get(b.id);
    if (!item || !BAND[b.to]) continue;
    if (BAND_ORDER.indexOf(b.to) > BAND_ORDER.indexOf(item.band)) {
      downgrades.push({ id: b.id, from: item.band, to: b.to, reason: b.reason });
      item.band = b.to; // never raised: only a strictly lower band is applied
    }
  }
  return { draft: out, deleted: [...del], downgrades };
}

// ───────────────────────────────────────────────────────────────── render

function substitute(text, pk) {
  return String(text).replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (pk.tokens.has(k) && !pk.tokens.get(k).stale ? pk.tokens.get(k).value : m));
}

/** Render the final markdown. Citation numbers follow first appearance; the Sources list matches. */
export function renderMemberBrief(draft, pk, { preview = false, unsubscribeLine = "", draftFailure = null } = {}) {
  const order = [];
  const num = (id) => {
    if (!pk.sources.has(id)) return null;
    let i = order.indexOf(id);
    if (i < 0) {
      order.push(id);
      i = order.length - 1;
    }
    return i + 1;
  };
  const marks = (cites) => {
    const ns = [...new Set((cites ?? []).map(num).filter(Boolean))];
    return ns.length ? ` ${ns.map((n) => `[${n}]`).join("")}` : "";
  };
  const sent = (s) => (s ? `${substitute(s.text, pk)}${marks(s.cites)}` : "");
  const lineWithCite = (l) => substitute(l, pk).replace(/\s*\[(S\d+)\]$/, (_, id) => marks([id]));
  const L = [];
  if (draftFailure) L.push(`> ⛔ **NOT SENT — failed closed.** ${draftFailure}\n`);
  if (preview) L.push("> 🔍 **Preview** — generated without sending.\n");
  L.push(`# ${V.short} Member Brief — ${fmtDate(pk.window.today)}`);
  L.push(`*Covering ${fmtDate(pk.window.fromDate)} through ${fmtDate(pk.window.toDate)}.*\n`);
  L.push("## The update\n");
  L.push(draft.update.map(sent).join(" ") || "_No update this edition._");
  L.push("\n## Policy & regulatory\n");
  if (pk.deadlines.length) {
    L.push("### ⏰ Open comment deadlines\n");
    for (const d of pk.deadlines) L.push(`- **${fmtDate(d.date)}** — [${d.title}](${d.url})${marks([d.cite])}`);
    L.push("");
  }
  const byId = new Map(draft.policy.map((p) => [p.id, p]));
  const items = [...pk.policy.values()].sort((a, b) => BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band));
  if (!items.length) L.push(`_No new federal, state or court actions on the ${V.short} watchlist since the last Member Brief._\n`);
  for (const it of items) {
    const p = byId.get(it.id);
    const body = p ? ["whatChanged", "whereItStands", "whatItMeans", "next"].map((k) => sent(p[k])).filter(Boolean) : [];
    if (!body.length) continue; // every sentence deleted in review → the item is not published
    L.push(`### ${it.headline || it.id}`);
    L.push(`**${BAND[it.band].label}.** _${BAND[it.band].caveat}_\n`);
    L.push(body.join(" "));
    L.push("");
  }
  L.push("## Markets\n");
  const SEC = [
    ["fund", "Fund positioning"],
    ["oilShare", "Oil share of crush"],
    ["ratio", "Soybean:corn price ratio"],
    ["barge", "Barge freight"],
  ];
  for (const [k, title] of SEC) {
    const f = pk.markets.get(k);
    L.push(`### ${title}\n`);
    for (const l of f?.lines ?? []) L.push(`- ${lineWithCite(l)}`);
    const words = (draft.markets[k] ?? []).map(sent).filter(Boolean).join(" ");
    if (words) L.push(`\n${words}`);
    L.push("");
  }
  L.push(`## What to watch (through ${fmtDate(pk.window.nextEdition)})\n`);
  if (!pk.watch.length) L.push("_Nothing dated on the calendar before the next Member Brief._");
  for (const w of pk.watch) L.push(`- **${fmtDate(w.date)}** — ${w.text}${marks([w.cite])}`);
  L.push("\n## Sources\n");
  order.forEach((id, i) => {
    const s = pk.sources.get(id);
    L.push(`${i + 1}. ${s.publisher} — ${s.url ? `[${s.title}](${s.url})` : s.title}${s.date ? `, ${fmtDate(s.date)}` : ""} _(${s.tierLabel ?? s.tier})_`);
  });
  L.push(`\n---\n_${EDUCATION_FOOTER}_`);
  if (unsubscribeLine) L.push(`\n_${unsubscribeLine}_`);
  return L.join("\n") + "\n";
}

// ───────────────────────────────────────────────────────────────── orchestration

export function memberRecipients(env = process.env, watchlist = null) {
  const out = [];
  const add = (v) => String(v ?? "").split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)).forEach((x) => out.push(x));
  add(env.MEMBER_BRIEF_TO);
  add(watchlist?.output?.memberBriefTo);
  try {
    add(fs.readFileSync(memberListPath(), "utf8").split(/\r?\n/).filter((l) => !l.trim().startsWith("#")).join(","));
  } catch {
    /* no list file */
  }
  return [...new Set(out)];
}
export const memberListPath = () => path.join(store.DATA_DIR, "member-list.txt");

export function unsubscribeAddress(env = process.env) {
  return env.MEMBER_BRIEF_REPLY_TO || (env.SMTP_FROM && /<([^>]+)>/.exec(env.SMTP_FROM)?.[1]) || env.SMTP_USER || "";
}

export function lastSent() {
  try {
    return JSON.parse(store.getState(LAST_SENT_KEY) || "null");
  } catch {
    return null;
  }
}

function reviewModelOf(env) {
  return env.REVIEW_MODEL || env.ANALYST_MODEL || env.BRIEF_MODEL || "claude-sonnet-5";
}

async function callDraft(client, model, pk, priorFailures) {
  // ⚠️ THE CACHE BREAKPOINT IS AFTER THE PACKET, NOT ON THE SYSTEM PROMPT. The static system prompt is
  // ~670 tokens — under Sonnet 5's 1,024-token cache minimum, so a breakpoint there would silently cache
  // nothing. System + packet (~10k tokens) is identical between the first draft and the retry, so the
  // retry reads it from cache; the rejection notes go in a second block AFTER the breakpoint.
  const content = [{ type: "text", text: packetPrompt(pk), cache_control: { type: "ephemeral" } }];
  if (priorFailures?.length) {
    content.push({ type: "text", text: `YOUR PREVIOUS DRAFT WAS REJECTED BY CODE for these reasons — fix every one, and when in doubt write less:\n${priorFailures.map((f) => `- ${f.path}: ${f.rule} — ${f.detail}`).join("\n")}` });
  }
  const resp = await client.messages.create({
    model,
    max_tokens: 6000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: { type: "json_schema", schema: MEMBER_SCHEMA } },
    system: [{ type: "text", text: MEMBER_SYSTEM }],
    messages: [{ role: "user", content }],
  });
  store.recordUsage(model, "member_brief", resp.usage.input_tokens, resp.usage.output_tokens, resp.usage, resp.stop_reason);
  if (wasTruncated(resp)) throw new StageError("draft_truncated", `draft hit max_tokens (${resp.usage.output_tokens})`);
  if (resp.stop_reason === "refusal") throw new StageError("draft_refused", "the model declined the draft");
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new StageError("draft_unparseable", err.message);
  }
}

async function callReview(client, model, pk, draft) {
  const lines = sentenceList(draft).map((x) => `${x.sid} [cites ${x.s.cites.join(", ") || "none"}] ${substitute(x.s.text, pk)}`);
  // Same breakpoint placement as the draft: system + packet cached, the draft under review after it.
  const content = [
    { type: "text", text: packetPrompt(pk), cache_control: { type: "ephemeral" } },
    { type: "text", text: `DRAFT SENTENCES TO REVIEW (tokens shown as their values):\n${lines.join("\n") || "(none)"}\n\nPOLICY ITEM BANDS:\n${[...pk.policy.values()].map((p) => `${p.id}: ${BAND[p.band].label}`).join("\n") || "(none)"}` },
  ];
  const req = {
    model,
    max_tokens: 8000,
    output_config: { effort: "high", format: { type: "json_schema", schema: REVIEW_SCHEMA } },
    system: [{ type: "text", text: REVIEW_SYSTEM }],
    messages: [{ role: "user", content }],
  };
  if (!/haiku/.test(model)) req.thinking = { type: "adaptive" };
  const resp = await client.messages.create(req);
  store.recordUsage(model, "member_review", resp.usage.input_tokens, resp.usage.output_tokens, resp.usage, resp.stop_reason);
  if (wasTruncated(resp)) throw new StageError("review_truncated", `review hit max_tokens (${resp.usage.output_tokens})`);
  if (resp.stop_reason === "refusal") throw new StageError("review_refused", "the reviewer declined");
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new StageError("review_unparseable", err.message);
  }
}

class StageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Full-document advice check after rendering (belt and braces over the per-sentence lint). */
function finalCompliance(markdown) {
  const body = markdown.split("\n---\n")[0]; // the footer quotes "buy, sell, or hold" by design
  return scanBanned(body);
}

/**
 * Generate, lint, review and (unless preview) send one Member Brief. One retry; then FAIL CLOSED.
 * @returns {{status:"sent"|"saved"|"preview", path:string, recipients:number, attempts:number, deleted:number, downgrades:object[]}}
 * @throws when the brief fails closed (after saving the draft and raising an alert)
 */
export async function runMemberBrief({ env = process.env, watchlist = null, preview = false, now = new Date(), client = null, log = console.log } = {}) {
  if (!env.ANTHROPIC_API_KEY && !client) throw new Error("ANTHROPIC_API_KEY is not set in .env");
  const tz = watchlist?.briefEditions?.timezone ?? V.tz;
  const spec = typeof watchlist?.briefEditions?.member === "string" && watchlist.briefEditions.member.trim() ? watchlist.briefEditions.member : DEFAULT_MEMBER_SPEC;
  const edition = preview ? "member-preview" : "member";
  const pk = buildMemberPacket({ now, tz, spec, lastSent: lastSent() });
  log(`🌾 Member Brief ${preview ? "(preview) " : ""}— window ${pk.window.fromDate} → ${pk.window.toDate}: ${pk.policy.size} policy item(s), ${pk.deadlines.length} open deadline(s), ${pk.sources.size} sources`);

  const unsubscribeLine = `You receive the ${V.short} Member Brief as an ${V.org} member. To unsubscribe, reply with "unsubscribe"${unsubscribeAddress(env) ? ` or write to ${unsubscribeAddress(env)}` : ""}.`;
  const failures = [];
  const gate = budget.check("member_brief", { env, watchlist, now });
  if (!gate.ok) failures.push({ attempt: 0, stage: "budget", detail: gate.reason });

  const api = client ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const draftModel = env.BRIEF_MODEL || "claude-sonnet-5";
  const reviewModel = reviewModelOf(env);
  let final = null;
  let attempts = 0;
  let priorLint = null;
  let lastDraft = null;
  for (let attempt = 1; attempt <= 2 && gate.ok && !final; attempt++) {
    attempts = attempt;
    try {
      const draft = normalizeDraft(await callDraft(api, draftModel, pk, priorLint));
      lastDraft = draft;
      const lint1 = lintMemberDraft(draft, pk);
      const incomplete = draftCompleteness(draft, pk);
      if (incomplete.length) lint1.failures = [...incomplete, ...lint1.failures];
      if (!lint1.ok || incomplete.length) {
        priorLint = lint1.failures;
        failures.push({ attempt, stage: "lint", detail: `${lint1.failures.length} failure(s): ${lint1.failures.slice(0, 6).map((f) => `${f.path} ${f.rule}`).join("; ")}` });
        log(`   ✋ attempt ${attempt}: draft failed lint (${lint1.failures.length})`);
        continue;
      }
      const review = await callReview(api, reviewModel, pk, draft);
      const gaps = reviewCoverage(draft, review, pk);
      if (gaps.length) {
        failures.push({ attempt, stage: "review incomplete", detail: `${gaps.length} problem(s): ${gaps.slice(0, 6).join("; ")}` });
        log(`   ✋ attempt ${attempt}: review incomplete (${gaps.length}) — an unreviewed sentence is never treated as approved`);
        continue;
      }
      const applied = applyReview(draft, review, pk);
      lastDraft = applied.draft;
      const lint2 = lintMemberDraft(applied.draft, pk);
      if (!lint2.ok) {
        priorLint = lint2.failures;
        failures.push({ attempt, stage: "post-review lint", detail: lint2.failures.slice(0, 6).map((f) => `${f.path} ${f.rule}`).join("; ") });
        continue;
      }
      final = { draft: applied.draft, deleted: applied.deleted.length, downgrades: applied.downgrades };
      log(`   ✅ attempt ${attempt}: passed lint + review (${applied.deleted.length} sentence(s) deleted, ${applied.downgrades.length} band downgrade(s))`);
    } catch (err) {
      failures.push({ attempt, stage: err.code ?? "error", detail: err.message });
      log(`   ✋ attempt ${attempt}: ${err.code ?? "error"} — ${err.message}`);
    }
  }

  const tzOpt = tz;
  if (!final) {
    const why = failures.map((f) => `attempt ${f.attempt} ${f.stage}: ${f.detail}`).join(" | ") || "no draft produced";
    const draftMd = renderMemberBrief(lastDraft ?? { update: [], policy: [], markets: { fund: [], oilShare: [], ratio: [], barge: [] } }, pk, { draftFailure: why });
    const file = saveBrief(draftMd, preview ? "member-preview-draft" : "member-draft", tzOpt);
    log(`   ⛔ Member Brief FAILED CLOSED — not sent. Draft saved to ${path.basename(file)}. ${why}`);
    try {
      await sendOpsAlert(`⛔ ${V.short} Member Brief NOT sent — ${fmtDate(pk.window.today)}`, `The Member Brief failed closed and was not sent.\n\nWhy: ${why}\n\nThe draft is saved as ${path.basename(file)} in the app (Saved briefs).`, env);
    } catch (err) {
      log(`   ⚠️ alert email failed: ${err.message}`);
    }
    const e = new Error(`Member Brief failed closed — not sent (${why}). Draft saved as ${path.basename(file)}.`);
    e.failedClosed = true;
    throw e;
  }

  const markdown = renderMemberBrief(final.draft, pk, { preview, unsubscribeLine });
  const advice = finalCompliance(markdown);
  if (advice.length) {
    const file = saveBrief(renderMemberBrief(final.draft, pk, { draftFailure: `advice language after render: ${advice.join(", ")}` }), preview ? "member-preview-draft" : "member-draft", tzOpt);
    const e = new Error(`Member Brief failed closed — advice language after render (${advice.join(", ")}). Draft saved as ${path.basename(file)}.`);
    e.failedClosed = true;
    throw e;
  }
  const file = saveBrief(markdown, edition, tzOpt);
  if (preview) return { status: "preview", path: file, recipients: 0, attempts, deleted: final.deleted, downgrades: final.downgrades };

  const recipients = memberRecipients(env, watchlist);
  if (!recipients.length) {
    log("   📭 Member Brief saved; no recipients configured (MEMBER_BRIEF_TO, Settings, or member-list.txt) — not emailed.");
    return { status: "saved", path: file, recipients: 0, attempts, deleted: final.deleted, downgrades: final.downgrades };
  }
  const sent = await sendMemberBriefEmail({ markdown, subject: `${V.short} Member Brief — ${fmtDate(pk.window.today)}`, recipients, env, unsubscribeTo: unsubscribeAddress(env) });
  if (sent) store.setState(LAST_SENT_KEY, JSON.stringify({ windowStart: pk.window.startISO, windowEnd: pk.window.endISO, sentAt: new Date().toISOString(), path: path.basename(file), recipients: recipients.length }));
  log(`   📧 Member Brief ${sent ? `sent to ${recipients.length} recipient(s) (BCC)` : "not sent — SMTP is not configured"}.`);
  return { status: sent ? "sent" : "saved", path: file, recipients: sent ? recipients.length : 0, attempts, deleted: final.deleted, downgrades: final.downgrades };
}
