// 1.45.0 — the Analyst Note and the market-education brief can run every day (e.g. 15:30 CT): the schedule
// grammar and Settings, the pre-report market refresh, honest dating, the previous-note block, forecast
// dedupe across notes, released-today calendar entries, and a dollar budget for the analysis group.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-daily-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
delete process.env.STATE_PACK;
delete process.env.MONTHLY_BUDGET_USD;
delete process.env.ANALYSIS_BUDGET_USD;

const schedule = await import("../src/schedule.js");
const calendar = await import("../src/calendar.js");
const budgetcore = await import("../src/budgetcore.js");
const store = await import("../src/store.js");
const pipeline = await import("../src/pipeline.js");

// ---------------------------------------------------------------- schedule grammar

test("parseDaySpec: Daily / Every day / Weekdays / Weekends, and real day names only", () => {
  assert.deepEqual(schedule.parseDaySpec("Daily 15:30").days.sort(), [...schedule.DAYS].sort());
  assert.deepEqual(schedule.parseDaySpec("every day 15:30").time, "15:30");
  assert.deepEqual(schedule.parseDaySpec("Weekdays 07:00").days, ["Mon", "Tue", "Wed", "Thu", "Fri"]);
  assert.deepEqual(schedule.parseDaySpec("Weekends 09:00").days, ["Sat", "Sun"]);
  assert.deepEqual(schedule.parseDaySpec("Thursday 10:00").days, ["Thu"]);
  assert.deepEqual(schedule.parseDaySpec("Tues,Thurs 9:00"), { days: ["Tue", "Thu"], time: "09:00" });
  // Used to read as "Monday" (first three letters); now rejected so it can't silently run on the wrong day.
  for (const bad of ["Mon Wed Fri 06:45", "Monthly 08:00", "Mon-Wed-Fri 07:00", "Daily 24:00", "Daily"]) assert.equal(schedule.parseDaySpec(bad), null, bad);
  // Plurals ran before 1.45.0 (only the first three letters were compared) and keep running.
  assert.deepEqual(schedule.parseDaySpec("Fridays 17:00"), { days: ["Fri"], time: "17:00" });
  assert.deepEqual(schedule.parseDaySpec("Mondays,Wednesdays,Fridays 06:45").days, ["Mon", "Wed", "Fri"]);
  // Everything that worked before still does.
  assert.deepEqual(schedule.parseDaySpec("Mon,Wed,Fri 06:45"), { days: ["Mon", "Wed", "Fri"], time: "06:45" });
  assert.equal(schedule.parseDaySpec("Mon-Sun 15:30").days.length, 7);
});

test("describe / canonical / expected gap", () => {
  assert.equal(schedule.describeDaySpec("Mon-Sun 15:30"), "Daily 15:30");
  assert.equal(schedule.describeDaySpec("Mon-Fri 07:00"), "Weekdays 07:00");
  assert.equal(schedule.describeDaySpec("Fri,Mon,Wed 06:45"), "Mon, Wed, Fri 06:45");
  assert.equal(schedule.describeDaySpec("Daily 3:30pm"), null);
  // Daily is STORED as a range, which every earlier version also parses (a rollback keeps the schedule).
  assert.equal(schedule.canonicalDaySpec("Daily 15:30"), "Mon-Sun 15:30");
  assert.equal(schedule.canonicalDaySpec("Weekdays 7:00"), "Mon-Fri 07:00");
  assert.equal(schedule.canonicalDaySpec("Fri 17:00"), "Fri 17:00");
  assert.equal(schedule.expectedGapDays("Daily 15:30"), 1);
  assert.equal(schedule.expectedGapDays("Mon,Wed,Fri 06:45"), 3);
  assert.equal(schedule.expectedGapDays("Weekdays 07:00"), 3);
  assert.equal(schedule.expectedGapDays("Fri 17:00"), 7);
  assert.equal(schedule.expectedGapDays("nonsense"), null);
});

test("dueEditions: a daily 15:30 spec fires on a Sunday, once, and both memos come due together", () => {
  const ED = { am: "06:30", pm: "16:30", education: "Mon-Sun 15:30", analyst: "Mon-Sun 15:30", timezone: "America/Chicago" };
  const sunday = new Date("2026-10-18T20:31:00Z"); // Sun 15:31 CDT
  const due = schedule.dueEditions(ED, sunday, new Set(["2026-10-18-am"]), ["weekly", "monthly", "education", "analyst"]).due;
  assert.deepEqual(due, ["education", "analyst"]);
  assert.deepEqual(schedule.dueEditions(ED, new Date("2026-10-18T20:29:00Z"), new Set(["2026-10-18-am"]), ["education", "analyst"]).due, [], "not before 15:30");
  const ran = new Set(["2026-10-18-am", "2026-10-18-education", "2026-10-18-analyst"]);
  assert.deepEqual(schedule.dueEditions(ED, sunday, ran, ["education", "analyst"]).due, [], "once a day");
});

// ---------------------------------------------------------------- calendar

test("a report released earlier TODAY is labelled RELEASED TODAY, not offered as upcoming", () => {
  const r = { date: "2026-11-10", time: "12:00", name: "November WASDE", type: "WASDE" };
  const at = (iso) => new Date(iso);
  assert.equal(calendar.releasedToday(r, at("2026-11-10T16:00:00Z")), false, "11:00 ET — not yet");
  assert.equal(calendar.releasedToday(r, at("2026-11-10T21:30:00Z")), true, "15:30 CT — out");
  assert.equal(calendar.releasedToday({ ...r, time: null }, at("2026-11-10T21:30:00Z")), false, "no release time (a deadline/window) → never 'released'");
  // The crop-insurance milestones carry a placeholder "00:00" — a window opening, not a midnight release.
  const ins = calendar.upcomingReports(3, at("2026-09-30T20:30:00Z")).find((x) => x.type === "INSURANCE_MILESTONE");
  if (ins) assert.equal(ins.time, null);
  assert.doesNotMatch(calendar.upcomingReportsText(3, at("2026-10-01T20:30:00Z")), /RELEASED TODAY at 00:00/);
  // The snapshot's "next release" for a series skips one that already came out today.
  const upcoming = [r, { date: "2026-12-09", time: "12:00", name: "December WASDE", type: "WASDE" }];
  assert.equal(pipeline.nextReleaseForSeries("wasde:soybeans:us:ending-stocks", upcoming, at("2026-11-10T21:30:00Z"))?.name ?? "December WASDE", "December WASDE");
  // The prompt text, end to end, on a real calendar day: Friday COT (15:30 ET) as seen at 15:30 CT.
  const text = calendar.upcomingReportsText(14, at("2026-10-16T20:30:00Z"));
  assert.match(text, /CFTC Commitments of Traders \(CFTC, impact low\) — RELEASED TODAY at 15:30 ET; it is NOT upcoming/);
  // A released-today line does not take one of the 8 slots: the Oct 9 WASDE is still listed on Sept 25.
  const sep25 = calendar.upcomingReportsText(14, at("2026-09-25T20:30:00Z"));
  assert.match(sep25, /RELEASED TODAY/);
  assert.match(sep25, /2026-10-09 12:00 ET: .*WASDE/);
});

test("weekly releases move off federal holidays (Labor Day, Thanksgiving, Juneteenth)", () => {
  const dates = (type, from, days = 10) => calendar.upcomingReports(days, new Date(from)).filter((r) => r.type === type).map((r) => r.date);
  assert.ok(dates("CROP_PROGRESS", "2026-09-03T12:00:00Z").includes("2026-09-08"), "Labor Day Monday → Tuesday");
  assert.ok(!dates("CROP_PROGRESS", "2026-09-03T12:00:00Z").includes("2026-09-07"));
  assert.deepEqual(dates("EXPORT_SALES", "2026-11-22T12:00:00Z", 8), ["2026-11-27"], "Thanksgiving Thursday → Friday");
  assert.deepEqual(dates("COT", "2026-06-15T12:00:00Z", 8), ["2026-06-22"], "Juneteenth Friday → Monday");
  // So on Labor Day the 15:30 note is NOT told Crop Progress came out that day.
  assert.doesNotMatch(calendar.upcomingReportsText(14, new Date("2026-09-07T20:30:00Z")), /Crop Progress[^\n]*RELEASED TODAY/);
});

// ---------------------------------------------------------------- budget

test("analysis budget in dollars: the analysis group gets exactly that, the rest share what's left", () => {
  const plain = budgetcore.allocations(75);
  assert.equal(plain.analysis, 15);
  const a = budgetcore.allocations(105, 45);
  assert.equal(a.analysis, 45);
  assert.ok(Math.abs(a.daily_brief - 21) < 1e-9 && Math.abs(a.member_brief - 12) < 1e-9 && Math.abs(a.panels - 15) < 1e-9, "the others keep their $75-era dollars at a $105 budget");
  const sum = Object.values(a).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 105) < 1e-9, "the monthly budget stays the single ceiling");
  // An override at or above the budget would starve every other group: it is ignored (back to shares).
  assert.equal(budgetcore.allocations(50, 80).analysis, 10);
  assert.equal(budgetcore.allocations(50, 50).panels, 10, "the other groups never drop to $0");
  assert.equal(budgetcore.analysisBudget({ ANALYSIS_BUDGET_USD: "45" }, { output: { analysisBudgetUsd: 10 } }), 45, "env wins");
  assert.equal(budgetcore.analysisBudget({}, { output: { analysisBudgetUsd: 10 } }), 10);
  assert.equal(budgetcore.analysisBudget({}, { output: {} }), null);
  const s = budgetcore.summarizeSpend([], 105, new Date(), 45);
  assert.equal(s.groups.find((g) => g.id === "analysis").allocation, 45);
});

test("budget.check honours the analysis override: a daily Analyst month isn't blocked at $15", async () => {
  const budget = await import("../src/budget.js");
  // ~$20 of memo spend this month — past the old 20% × $75 = $15 allocation.
  store.recordUsage("claude-opus-4-8", "memo", 1_000_000, 600_000); // $5 + $15 = $20 at $5/$25
  try {
    const wl = (o) => ({ output: { monthlyBudgetUsd: 105, ...o } });
    assert.equal(budget.check("memo", { env: {}, watchlist: { output: { monthlyBudgetUsd: 75 } } }).ok, false, "the default share blocks it");
    assert.equal(budget.check("memo", { env: {}, watchlist: wl({ analysisBudgetUsd: 45 }) }).ok, true, "$45 analysis budget lets it run");
  } finally {
    const Database = (await import("better-sqlite3")).default;
    new Database(store.DB_PATH).prepare("DELETE FROM token_usage WHERE purpose = 'memo'").run();
  }
});

// ---------------------------------------------------------------- pre-report market refresh

test("pre-report market refresh: runs when the price feeds are stale, skips when fresh, never throws", async () => {
  const calls = [];
  const refresh = async () => {
    calls.push(1);
    return { seriesCount: 7, failed: [] };
  };
  const now = Date.parse("2026-10-16T20:30:00Z");
  store.setMarketRunSuccess("cbot_futures", 4, "2026-10-16T11:35:00Z"); // the 06:35 CT AM run
  const r1 = await pipeline.refreshMarketsBeforeReport({ env: {}, now, refresh, log: () => {} });
  assert.equal(r1.refreshed, true);
  assert.equal(calls.length, 1);
  store.setMarketRunSuccess("cbot_futures", 4, "2026-10-16T20:20:00Z"); // 10 minutes ago (the first memo's refresh)
  const r2 = await pipeline.refreshMarketsBeforeReport({ env: {}, now, refresh, log: () => {} });
  assert.equal(r2.refreshed, false, "the second report of the pair does not refresh again");
  assert.equal(calls.length, 1);
  store.setMarketRunSuccess("cbot_futures", 4, "2026-10-16T09:00:00Z");
  const r3 = await pipeline.refreshMarketsBeforeReport({ env: {}, now, refresh: async () => { throw new Error("CME down"); }, log: () => {} });
  assert.equal(r3.refreshed, false);
  assert.match(r3.reason, /CME down/);
});

// ---------------------------------------------------------------- dating + continuity

test("AS OF line says which session is in the data, and that a weekend has none", () => {
  const snap = (period) => [{ series: "cbot:zs:front", latest: { period } }];
  assert.match(pipeline.asOfLine("America/Chicago", { now: new Date("2026-10-16T20:30:00Z"), snapshot: snap("2026-10-16") }), /written 2026-10-16 15:30 .* Friday\. .*2026-10-16 — today's session IS in the data/);
  assert.match(pipeline.asOfLine("America/Chicago", { now: new Date("2026-10-16T20:30:00Z"), snapshot: snap("2026-10-15") }), /today's session is NOT in the data\.$/);
  assert.match(pipeline.asOfLine("America/Chicago", { now: new Date("2026-10-17T20:30:00Z"), snapshot: snap("2026-10-16") }), /NOT in the data \(weekend: no session\)/);
});

test("memo context never folds the memo editions back in; the previous note comes labelled, from an earlier day", () => {
  for (const f of ["2026-10-16-analyst.md", "2026-10-16-education.md", "2026-10-16-weekly.md", "2026-10-16-member.md", "2026-10-16-member-preview-draft.md"]) assert.ok(pipeline.MEMO_BRIEF_FILE.test(`briefings/${f}`), f);
  for (const f of ["2026-10-16-am.md", "2026-10-16-pm.md"]) assert.ok(!pipeline.MEMO_BRIEF_FILE.test(`briefings/${f}`), f);
  const dir = path.join(DIR, "briefings");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "2026-10-14-analyst.md"), "## Analyst Note 14th\nThe read: crush strong.");
  fs.writeFileSync(path.join(dir, "2026-10-15-analyst.md"), "## Analyst Note 15th\nThe read: crush still strong.");
  fs.writeFileSync(path.join(dir, "2026-10-16-analyst.md"), "## Analyst Note 16th (this morning's manual run)");
  const briefs = ["2026-10-16-analyst.md", "2026-10-15-analyst.md", "2026-10-14-analyst.md", "2026-10-15-am.md"].map((f) => ({ path: `briefings/${f}` }));
  const block = pipeline.previousNoteBlock(pipeline.MEMO_PRESETS.analyst, "2026-10-16", { briefs, dataDir: DIR });
  assert.match(block, /^=== YOUR PREVIOUS NOTE \(2026-10-15, Analyst Note\) — your own earlier output, for continuity only; NOT evidence ===\n## Analyst Note 15th/);
  assert.equal(pipeline.previousNoteBlock(pipeline.MEMO_PRESETS.analyst, "2026-10-14", { briefs, dataDir: DIR }), "", "nothing before the first note");
  assert.equal(pipeline.MEMO_PRESETS.weekly.previousNote, undefined, "weekly/monthly unchanged");
  for (const id of ["analyst", "education"]) {
    const sys = pipeline.MEMO_PRESETS[id].system("2026-10-16");
    assert.match(sys, /say "today" only for data dated today/);
    assert.match(sys, /lead with what changed since it/);
    assert.match(sys, /never cite it as support/);
    assert.match(sys, /If no previous note is provided, write the full read/);
  }
  assert.match(pipeline.MEMO_PRESETS.analyst.system("2026-10-16"), /Only if YOUR PREVIOUS NOTE is provided: in "What the signals say"/);
});

// ---------------------------------------------------------------- forecast ledger

test("a daily note restating a pending call does not file it again; a new call, or a re-run of the same note, still files", () => {
  const SERIES = "cbot:zs:front";
  const bySeries = new Map([[SERIES, { series: SERIES, latest: { value: 1050, period: "2026-10-15" } }]]);
  const createdAt = new Date().toISOString();
  const claim = (over = {}) => ({ claim: "Soybeans rise over the next month.", direction: "up", comparator: "rises", series: SERIES, horizonDays: 30, confidence: "medium", ...over });
  const file = (c, briefPath) => pipeline.fileForecastFromClaim(c, { briefPath, edition: "analyst", createdAt, bySeries, skipIfPending: true });
  assert.equal(file(claim(), "briefings/2026-10-15-analyst.md"), true);
  assert.equal(file(claim({ claim: "Soybean futures should keep climbing into November." }), "briefings/2026-10-16-analyst.md"), false, "same call, reworded, next day");
  assert.equal(file(claim({ claim: "Soybeans rise over the next month (rerun)." }), "briefings/2026-10-15-analyst.md"), true, "a re-run of the SAME note still upserts");
  assert.equal(file(claim({ direction: "down", comparator: "falls", claim: "Soybeans fall." }), "briefings/2026-10-16-analyst.md"), true, "the opposite call is new");
  assert.equal(file(claim({ comparator: "stays_above", direction: "n/a", threshold: 1000, claim: "Holds above 1000." }), "briefings/2026-10-16-analyst.md"), true);
  assert.equal(file(claim({ comparator: "stays_above", direction: "n/a", threshold: 1002, claim: "Holds above 1002." }), "briefings/2026-10-17-analyst.md"), false, "same level within 0.5%");
  assert.equal(file(claim({ comparator: "stays_above", direction: "n/a", threshold: 1100, claim: "Holds above 1100." }), "briefings/2026-10-17-analyst.md"), true, "a different level is a different call");
  // A different horizon is a different prediction (it resolves on a different date).
  assert.equal(file(claim({ horizonDays: 365, claim: "Soybeans rise over the next year." }), "briefings/2026-10-18-analyst.md"), true);
  // Direction text is noise once there is a comparator: "stays above 1100" with direction "up" is the same call.
  assert.equal(file(claim({ comparator: "stays_above", direction: "up", threshold: 1100, claim: "Stays above 1100." }), "briefings/2026-10-18-analyst.md"), false);
  // A restatement demotes the pending row's confidence and fills a missing Challenger verdict — never raises it.
  const before = store.listForecasts({ limit: 100 }).find((r) => r.brief_path === "briefings/2026-10-15-analyst.md" && r.comparator === "rises");
  assert.equal(before.confidence, "medium");
  pipeline.fileForecastFromClaim(claim({ confidence: "low", claim: "Soy up, lower conviction." }), { briefPath: "briefings/2026-10-19-analyst.md", edition: "analyst", createdAt, bySeries, skipIfPending: true, challengeVerdict: "lower_confidence", thesisKey: "briefings/2026-10-19-analyst.md#0" });
  pipeline.fileForecastFromClaim(claim({ confidence: "high", claim: "Soy up, high conviction." }), { briefPath: "briefings/2026-10-20-analyst.md", edition: "analyst", createdAt, bySeries, skipIfPending: true });
  const after = store.listForecasts({ limit: 100 }).find((r) => r.id === before.id);
  assert.equal(after.confidence, "low", "demoted, and a later high-confidence restatement does not raise it back");
  assert.equal(after.challenge_verdict, "lower_confidence");
  assert.equal(after.thesis_key, "briefings/2026-10-19-analyst.md#0");
  // Without the flag (CLI extraction, tests of the two filing paths) nothing changes.
  assert.equal(pipeline.fileForecastFromClaim(claim(), { briefPath: "briefings/x.md", edition: "analyst", createdAt, bySeries }), true);
});

// ---------------------------------------------------------------- Settings

test("Settings: Daily 15:30 saves as Mon-Sun 15:30, shows as Daily, a custom spec survives an unrelated Save, analysis budget validates", async () => {
  const { startServer } = await import("../src/server.js");
  const { loadWatchlist, saveWatchlist } = pipeline;
  const server = await startServer({ port: 0, schedule: false });
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
  const port = server.address().port;
  const req = (method, p, body = null) =>
    new Promise((resolve, reject) => {
      const r = http.request({ port, path: p, method, headers: body ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } : {} }, (res) => {
        const b = [];
        res.on("data", (c) => b.push(c));
        res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location ?? "", body: Buffer.concat(b).toString() }));
      });
      r.on("error", reject);
      if (body) r.write(body);
      r.end();
    });
  const post = (fields) => req("POST", "/watchlist/settings", new URLSearchParams(fields).toString());
  try {
    let r = await post({ analystDay: "Daily", analystTime: "15:30", educationDay: "Daily", educationTime: "15:30", monthlyBudgetUsd: "105", analysisBudgetUsd: "45" });
    assert.match(decodeURIComponent(r.location), /Settings saved/);
    let wl = loadWatchlist();
    assert.equal(wl.briefEditions.analyst, "Mon-Sun 15:30");
    assert.equal(wl.briefEditions.education, "Mon-Sun 15:30");
    assert.equal(wl.output.analysisBudgetUsd, 45);
    assert.equal(wl.output.monthlyBudgetUsd, 105);

    const page = (await req("GET", "/logs?open=settings")).body;
    assert.match(page, /<select name="analystDay">[\s\S]*?<option value="Daily" selected>Daily<\/option>/);
    assert.match(page, /<td>🔭 Analyst Note<\/td><td>[^<]*(<span[^>]*>[^<]*<\/span>)?<\/td><td>Daily 15:30<\/td>/);

    // A hand-edited custom spec renders as a selected "keep" option and survives a Save of something else.
    wl.briefEditions.education = "Mon,Wed,Fri 15:30";
    saveWatchlist(wl);
    const page2 = (await req("GET", "/logs?open=settings")).body;
    assert.match(page2, /<option value="keep" selected>custom: Mon, Wed, Fri<\/option>/);
    r = await post({ educationDay: "keep", educationTime: "15:30", maxItemsInBrief: "30" });
    assert.match(decodeURIComponent(r.location), /Settings saved/);
    assert.equal(loadWatchlist().briefEditions.education, "Mon,Wed,Fri 15:30", "an unrelated Save no longer deletes it");

    // Changing the time of a custom spec keeps its days and applies the time.
    r = await post({ educationDay: "keep", educationTime: "16:15" });
    assert.equal(loadWatchlist().briefEditions.education, "Mon,Wed,Fri 16:15");
    // Weekends is a dropdown choice now, not a "custom" one.
    await post({ educationDay: "Weekends", educationTime: "09:00" });
    assert.equal(loadWatchlist().briefEditions.education, "Sat,Sun 09:00");
    assert.match((await req("GET", "/logs?open=settings")).body, /<option value="Weekends" selected>Weekends<\/option>/);
    // A stored "off" reads as off — not as an unreadable schedule.
    wl = loadWatchlist();
    wl.briefEditions.weekly = "off";
    saveWatchlist(wl);
    const page3 = (await req("GET", "/logs?open=settings")).body;
    assert.match(page3, /<select name="weeklyDay">\s*<option value="off" selected>off<\/option>/);
    assert.doesNotMatch(page3, /not understood: off/);

    // The analysis budget must leave room for everything else; blank returns it to the 20% share.
    r = await post({ monthlyBudgetUsd: "105", analysisBudgetUsd: "200" });
    assert.match(decodeURIComponent(r.location), /must be less than the monthly budget/);
    assert.equal(loadWatchlist().output.analysisBudgetUsd, 45, "a rejected save changes nothing");
    // …including when it is the MONTHLY budget that is lowered under an existing analysis budget.
    r = await post({ monthlyBudgetUsd: "40" });
    assert.match(decodeURIComponent(r.location), /must be less than the monthly budget \(\$40\)/);
    assert.equal(loadWatchlist().output.monthlyBudgetUsd, 105);
    r = await post({ analysisBudgetUsd: "" });
    assert.equal(loadWatchlist().output.analysisBudgetUsd, undefined);
    // "off" still turns a report back to on-demand.
    await post({ analystDay: "off", analystTime: "15:30" });
    assert.equal(loadWatchlist().briefEditions.analyst, undefined);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("the brief window is chosen by date, not by the newest 40 rows (daily memos would crowd it out)", async () => {
  const Database = (await import("better-sqlite3")).default;
  const raw = new Database(store.DB_PATH);
  // 14 days of AM + PM + daily analyst/education/member files (≈5 rows a day, 70 in all): the newest 40
  // rows would reach back only ~8 days. Selected by date, every AM/PM brief in the window survives.
  const now = Date.now();
  const ins = raw.prepare("INSERT INTO briefs (edition, created_at, path) VALUES (?, ?, ?)");
  for (let d = 0; d < 14; d++) {
    const at = new Date(now - d * 86400e3 - 3600e3).toISOString();
    for (const ed of ["am", "pm", "analyst", "education", "member"]) ins.run(ed, at, `briefings/win-${d}-${ed}.md`);
  }
  try {
    const since = store.listBriefsSince(new Date(now - 14 * 86400e3).toISOString()).filter((b) => b.path.startsWith("briefings/win-"));
    assert.equal(since.length, 70);
    const kept = since.filter((b) => !pipeline.MEMO_BRIEF_FILE.test(b.path));
    assert.equal(kept.length, 28, "every AM/PM brief of the 14 days, none of the memo files");
    const old = store.listBriefs(40).filter((b) => b.path.startsWith("briefings/win-") && !pipeline.MEMO_BRIEF_FILE.test(b.path));
    assert.ok(old.length < 28, `the old LIMIT-40-then-filter kept only ${old.length}`);
  } finally {
    raw.prepare("DELETE FROM briefs WHERE path LIKE 'briefings/win-%'").run();
  }
});
