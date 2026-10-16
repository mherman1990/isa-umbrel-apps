// schedule.js — the scheduler's decisions as pure functions, so they can be tested without a clock.
//
// server.startScheduler() calls these every 30 s. Three things changed in 1.39.0 (Phase 0 audit §5):
//
//   1. "ALREADY RAN" COMES FROM brief_runs, NOT FROM SAVED FILES. The restart-dedup set used to be seeded
//      from brief files only, but a quiet AM writes no file — so any same-day restart re-ran the whole AM
//      edition (every model call twice). A run row exists for every AM/PM run, quiet or not. A run that
//      FAILED still counts as done for the day (no retry storm), except one interrupted by a restart,
//      which is re-run.
//   2. DAY SPECS TAKE SEVERAL DAYS. "Fri 17:00" still works; "Mon,Wed,Fri 06:45" now works too (the
//      Member Brief).
//   3. THE DATA IS FRESH BEFORE ANY REPORT. A report may not run on a day whose AM refresh has not
//      completed — the scheduler runs the AM edition first (see `needsRefreshFirst`).
//
// 1.45.0: "Daily 15:30", "Weekdays 07:00" and "Weekends 09:00" are accepted, and day names must be real
// day names (abbreviated, full, or plural: "Fri", "Friday", "Fridays"). Settings stores a daily schedule as
// "Mon-Sun HH:MM" (canonicalDaySpec), which the 1.39–1.44 scheduler also runs; note that the 1.39–1.44
// Settings page can only show single days, so saving Settings after a rollback turns such a schedule off.

import { pack } from "./pack.js";

export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const FULL_DAY = { sun: "Sun", sunday: "Sun", mon: "Mon", monday: "Mon", tue: "Tue", tues: "Tue", tuesday: "Tue", wed: "Wed", weds: "Wed", wednesday: "Wed", thu: "Thu", thur: "Thu", thurs: "Thu", thursday: "Thu", fri: "Fri", friday: "Fri", sat: "Sat", saturday: "Sat" };
// Whole-spec words. Matched on the day part as a whole, before it is split into days.
const DAY_ALIASES = {
  daily: DAYS,
  "every day": DAYS,
  everyday: DAYS,
  weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  weekends: ["Sat", "Sun"],
};

/**
 * Parse a day-scheduled spec. Accepts "Fri 17:00", "Mon,Wed,Fri 06:45", "Mon, Wed, Fri 06:45",
 * "Mon-Fri 07:00", "Daily 15:30" / "Every day 15:30", "Weekdays 07:00", "Weekends 09:00". Day names are
 * the 3-letter abbreviation or the full name — "Mon Wed Fri" (no commas) or "Monthly" is rejected rather
 * than read as Monday. Returns null for anything malformed (a hand-edited watchlist must never throw).
 * @returns {{days: string[], time: string} | null}
 */
export function parseDaySpec(spec) {
  if (typeof spec !== "string") return null;
  const m = spec.trim().match(/^([A-Za-z,\s-]+?)\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  if (hh > 23 || mm > 59) return null;
  const time = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  const alias = DAY_ALIASES[m[1].trim().toLowerCase().replace(/\s+/g, " ")];
  if (alias) return { days: [...alias], time };
  // Plural names ("Fridays", "Mondays,Wednesdays") ran before 1.45.0, when only the first three letters
  // were compared — keep them working; "Monthly" and "Mon Wed Fri" stay rejected.
  const norm = (d) => {
    const t = d.trim().toLowerCase();
    return FULL_DAY[t] ?? (t.endsWith("s") ? FULL_DAY[t.slice(0, -1)] : undefined);
  };
  const days = [];
  for (const part of m[1].split(",").map((p) => p.trim()).filter(Boolean)) {
    const range = part.split("-").map((p) => p.trim());
    if (range.length > 2) return null;
    if (range.length === 2) {
      const a = DAYS.indexOf(norm(range[0]) ?? "");
      const b = DAYS.indexOf(norm(range[1]) ?? "");
      if (a < 0 || b < 0) return null;
      for (let i = a; ; i = (i + 1) % 7) {
        days.push(DAYS[i]);
        if (i === b) break;
      }
    } else {
      const d = norm(part);
      if (!d) return null;
      days.push(d);
    }
  }
  if (!days.length) return null;
  return { days: [...new Set(days)], time };
}

const WEEK_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const sameDays = (a, b) => a.length === b.length && b.every((d) => a.includes(d));

/** The days of a parsed spec as a word: "Daily", "Weekdays", "Weekends", "Fri", or "Mon, Wed, Fri". */
export function dayWord(days) {
  if (sameDays(days, DAYS)) return "Daily";
  if (sameDays(days, DAY_ALIASES.weekdays)) return "Weekdays";
  if (sameDays(days, DAY_ALIASES.weekends)) return "Weekends";
  return WEEK_ORDER.filter((d) => days.includes(d)).join(", ");
}

/** A readable schedule ("Daily 15:30", "Mon, Wed, Fri 06:45"), or null when the spec will not run. */
export function describeDaySpec(spec) {
  const p = parseDaySpec(spec);
  return p ? `${dayWord(p.days)} ${p.time}` : null;
}

/**
 * The form Settings stores. Daily and weekdays are written as ranges ("Mon-Sun 15:30", "Mon-Fri 07:00")
 * because the 1.39–1.44 scheduler also parses ranges, so a rolled-back app keeps RUNNING the schedule
 * (its Settings page can't display it, though — see the header). Anything else is its days in week
 * order. Null when the spec does not parse.
 */
export function canonicalDaySpec(spec) {
  const p = parseDaySpec(spec);
  if (!p) return null;
  if (sameDays(p.days, DAYS)) return `Mon-Sun ${p.time}`;
  if (sameDays(p.days, DAY_ALIASES.weekdays)) return `Mon-Fri ${p.time}`;
  return `${WEEK_ORDER.filter((d) => p.days.includes(d)).join(",")} ${p.time}`;
}

/**
 * The longest gap, in days, between two scheduled runs — how long a healthy schedule can go without a
 * new edition (daily → 1, Mon/Wed/Fri → 3, Fri → 7). Null when the spec does not parse.
 */
export function expectedGapDays(spec) {
  const p = parseDaySpec(spec);
  if (!p) return null;
  const idx = p.days.map((d) => DAYS.indexOf(d)).sort((a, b) => a - b);
  let gap = 0;
  for (let i = 0; i < idx.length; i++) gap = Math.max(gap, ((idx[(i + 1) % idx.length] - idx[i] + 6) % 7) + 1);
  return gap;
}

/** Local date label (YYYY-MM-DD), HH:MM and weekday ("Fri") in `timezone`. Throws on a bad timezone. */
export function localClock(now, timezone) {
  return {
    date: new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now),
    hhmm: new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(now),
    weekday: new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(now),
  };
}

const INTERRUPTED = /interrupted/i;

/**
 * The set of "<date>-<edition>" keys that count as already run, from run rows and saved brief files.
 * @param {{edition:string, started_at:string, status:string, error?:string}[]} runs   brief_runs rows
 * @param {string[]} briefFiles  saved brief basenames ("2026-10-02-weekly.md")
 */
export function seedRan(runs, briefFiles, timezone) {
  const ran = new Set();
  for (const r of runs ?? []) {
    if (r.status === "running") continue; // live (or about to be marked interrupted)
    if (r.status === "failed" && INTERRUPTED.test(r.error ?? "")) continue; // died with the process → re-run
    const d = localClock(new Date(r.started_at), timezone).date;
    ran.add(`${d}-${r.edition}`);
  }
  for (const f of briefFiles ?? []) {
    const m = String(f).match(/^(\d{4}-\d{2}-\d{2})-([a-z]+)\.md$/);
    if (m) ran.add(`${m[1]}-${m[2]}`);
  }
  return ran;
}

/**
 * Which editions are due right now, in the order they must run. AM/PM first (they ARE the refresh),
 * then the day-scheduled reports.
 * @param {object} editions  watchlist.briefEditions
 * @param {Set<string>} ran
 * @param {string[]} dayScheduled  edition ids that take a day spec
 */
export function dueEditions(editions, now, ran, dayScheduled) {
  const timezone = editions.timezone ?? pack().identity.timezone;
  const { date, hhmm, weekday } = localClock(now, timezone);
  const due = [];
  for (const edition of ["am", "pm"]) {
    const t = editions[edition];
    if (typeof t === "string" && /^\d{2}:\d{2}$/.test(t) && hhmm >= t && !ran.has(`${date}-${edition}`)) due.push(edition);
  }
  for (const edition of dayScheduled) {
    const spec = parseDaySpec(editions[edition]);
    if (!spec || !spec.days.includes(weekday)) continue;
    if (hhmm >= spec.time && !ran.has(`${date}-${edition}`)) due.push(edition);
  }
  return { date, due };
}

/**
 * Must the day's data refresh run before this report? True when no AM or PM pipeline run has completed
 * OK today. Reports read stored data; without this, an Analyst Note scheduled for 06:00 (before the 06:30
 * AM refresh) — or any report on a day the AM failed — was written from yesterday's series and items.
 */
export function needsRefreshFirst(todaysRuns) {
  return !(todaysRuns ?? []).some((r) => (r.edition === "am" || r.edition === "pm") && r.status === "ok");
}
