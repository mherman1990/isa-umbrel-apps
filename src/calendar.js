// calendar.js — the USDA / market report release calendar.
//
// The grain market moves on scheduled reports, not on a fixed twice-a-day clock. Fixed report
// dates + impact levels come from the authoritative data file (src/data/calendar_events.2026.json,
// per USDA/CME calendars); weekly feeds (export sales, crop progress, CFTC) are computed from
// their recurrence. Powers the Markets "Coming up" panel + the Analyst/Pulse context, and the
// pre-report-positioning condition trigger.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pack } from "./pack.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");

// YEAR-AGNOSTIC (1.39.0). The loader used to open `calendar_events.2026.json` and `policy_events.2026.json`
// by name, so on 2026-12-11 the calendar, the "Coming up" panel, the pre-report trigger and every
// "next release" line would have gone silent with no error. It now merges EVERY `<prefix>.<year>.json`
// in src/data, so adding next year's calendar is dropping in one file — and calendarCoverage() says,
// on the health page, how far ahead the authored dates actually reach.
function loadAll(prefix, empty) {
  const merged = structuredClone(empty);
  let files = [];
  try {
    files = fs.readdirSync(DATA_DIR).filter((f) => new RegExp(`^${prefix}\\.\\d{4}\\.json$`).test(f)).sort();
  } catch {
    return merged;
  }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
      for (const k of Object.keys(empty)) merged[k].push(...(j[k] ?? []));
    } catch {
      /* one malformed year must not blank the others */
    }
  }
  return merged;
}

let CAL = null;
function loadCal() {
  if (!CAL) CAL = loadAll("calendar_events", { events: [], recurring_events: [] });
  return CAL;
}

// Political/policy dates (elections, farm bill / appropriations deadlines, legislative sessions,
// regulatory milestones) — a separate authored file so the homepage calendar shows more than USDA
// reports. Comment deadlines are NOT here (captured dynamically per-rule in store.upcomingDeadlines).
let POL = null;
// State-specific events carry `state` and show only under that state's pack; a shared event may carry
// `stateNotes` with a state's own wording (the Iowa ballot on the general election, say).
function loadPolicy() {
  if (!POL) {
    POL = loadAll("policy_events", { events: [] });
    const alpha = pack().identity.stateAlpha;
    POL.events = POL.events
      .filter((e) => !e.state || e.state === alpha)
      .map((e) => (e.stateNotes?.[alpha] ? { ...e, note: e.stateNotes[alpha] } : e));
  }
  return POL;
}

/** Test hook: forget the cached files. */
export function _resetCalendarCache() {
  CAL = null;
  POL = null;
}

/** How far ahead the authored calendars reach. A gap here is invisible in the UI until it bites. */
export function calendarCoverage(from = new Date(), warnDays = 60) {
  const today = from.toISOString().slice(0, 10);
  const horizon = new Date(from.getTime() + warnDays * 86400e3).toISOString().slice(0, 10);
  const fixed = (loadCal().events ?? []).map((e) => e.date).filter(Boolean).sort();
  const policy = (loadPolicy().events ?? []).map((e) => e.date).filter(Boolean).sort();
  const lastFixed = fixed[fixed.length - 1] ?? null;
  const ahead = fixed.filter((d) => d >= today);
  return {
    lastFixedEvent: lastFixed,
    lastPolicyEvent: policy[policy.length - 1] ?? null,
    fixedAhead: ahead.length,
    fixedWithinWarn: ahead.filter((d) => d <= horizon).length,
    // Warn when the authored USDA dates end within the window — the WASDE that falls just past the
    // last authored date is exactly the one the brief would fail to mention.
    warn: !lastFixed || lastFixed < horizon,
  };
}

/**
 * Upcoming political/policy events within `days`, soonest first. Each: { date, name, category,
 * impact, type, note }. Category ∈ election|legislative|budget|regulatory.
 */
export function upcomingPolicyEvents(days = 120, from = new Date()) {
  const startISO = from.toISOString().slice(0, 10);
  const endISO = new Date(from.getTime() + days * 86400e3).toISOString().slice(0, 10);
  return (loadPolicy().events ?? [])
    .filter((e) => e.date && e.date >= startISO && e.date <= endISO)
    .map((e) => ({ date: e.date, name: e.title, category: e.category || "policy", impact: e.impact || "medium", type: e.type, note: e.note || "" }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Compact text of upcoming policy deadlines (with impact) for injecting into memo/analyst prompts. */
export function upcomingPolicyEventsText(days = 120) {
  const list = upcomingPolicyEvents(days);
  if (!list.length) return "";
  return list.slice(0, 8).map((e) => `- ${e.date}: ${e.name} (${e.category}, impact ${e.impact}) — ${e.note}`).join("\n");
}

const AGENCY = { WASDE: "USDA", GRAIN_STOCKS: "USDA NASS", ACREAGE: "USDA NASS", PROSPECTIVE_PLANTINGS: "USDA NASS", CROP_PROGRESS: "USDA NASS", EXPORT_SALES: "USDA FAS", INSURANCE_MILESTONE: "USDA RMA", COT: "CFTC" };
const agencyOf = (type) => AGENCY[type] || "USDA";

const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
// CFTC COT isn't in the USDA data file; it's a weekly Friday release.
const CFTC_RECUR = { title: "CFTC Commitments of Traders", type: "COT", impact: "low", watch_template: "Weekly managed-money fund positioning, as of the prior Tuesday.", recurrence: { freq: "WEEKLY", byday: ["FR"] } };

function recurOccurrences(r, from, end) {
  const rec = r.recurrence;
  if (!rec || rec.freq !== "WEEKLY") return [];
  const days = (rec.byday || []).map((d) => DOW[d]).filter((n) => n != null);
  const wStart = rec.window_start ? Date.parse(rec.window_start + "T00:00:00Z") : null;
  const wEnd = rec.window_end ? Date.parse(rec.window_end + "T23:59:59Z") : null;
  const out = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 12));
  while (d <= end) {
    if (days.includes(d.getUTCDay()) && d >= from && (!wStart || d.getTime() >= wStart) && (!wEnd || d.getTime() <= wEnd)) {
      out.push(d.toISOString().slice(0, 10));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Upcoming report releases within `days`, soonest first. Each: { date, name, agency, impact,
 * type, note }. Fixed events (impact very_high/high/medium) from the data file; weekly feeds
 * (export sales, crop progress, CFTC) computed and marked low unless the file says otherwise.
 */
export function upcomingReports(days = 21, from = new Date()) {
  const cal = loadCal();
  const end = new Date(from.getTime() + days * 86400e3);
  const startISO = from.toISOString().slice(0, 10);
  const endISO = end.toISOString().slice(0, 10);
  const out = [];
  for (const e of cal.events ?? []) {
    if (e.date && e.date >= startISO && e.date <= endISO) {
      out.push({ date: e.date, name: e.title, agency: agencyOf(e.type), impact: e.impact || "medium", type: e.type, note: e.watch_template || e.history_note || "" });
    }
  }
  for (const r of [...(cal.recurring_events ?? []), CFTC_RECUR]) {
    for (const date of recurOccurrences(r, from, end)) {
      out.push({ date, name: r.title, agency: agencyOf(r.type), impact: r.impact || "low", type: r.type, note: r.watch_template || "" });
    }
  }
  const seen = new Set();
  return out
    .filter((x) => { const k = x.date + x.name; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.date.localeCompare(b.date));
}

const IMPACT_RANK = { very_high: 3, high: 2, medium: 1, low: 0 };

/** The next report at or above `minImpact` within `days` — for the pre-report positioning trigger. */
export function nextImpactfulReport(minImpact = "very_high", days = 21, from = new Date()) {
  const min = IMPACT_RANK[minImpact] ?? 3;
  return upcomingReports(days, from).find((r) => (IMPACT_RANK[r.impact] ?? 0) >= min) || null;
}

/** Compact text of the next few releases (with impact), for injecting into memo/analyst prompts. */
export function upcomingReportsText(days = 14) {
  const list = upcomingReports(days);
  if (!list.length) return "";
  return list.slice(0, 8).map((r) => `- ${r.date}: ${r.name} (${r.agency}, impact ${r.impact}) — ${r.note}`).join("\n");
}
