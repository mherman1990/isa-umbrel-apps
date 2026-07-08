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

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
let CAL = null;
function loadCal() {
  if (CAL) return CAL;
  try {
    CAL = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "calendar_events.2026.json"), "utf8"));
  } catch {
    CAL = { events: [], recurring_events: [] };
  }
  return CAL;
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
