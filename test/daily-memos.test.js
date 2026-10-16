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
  assert.equal(calendar.releasedToday({ ...r, time: null }, at("2026-11-10T21:30:00Z")), false, "no time → treated as out only at end of day");
  // The snapshot's "next release" for a series skips one that already came out today.
  const upcoming = [r, { date: "2026-12-09", time: "12:00", name: "December WASDE", type: "WASDE" }];
  assert.equal(pipeline.nextReleaseForSeries("wasde:soybeans:us:ending-stocks", upcoming, at("2026-11-10T21:30:00Z"))?.name ?? "December WASDE", "December WASDE");
  // The prompt text, end to end, on a real calendar day: Friday COT (15:30 ET) as seen at 15:30 CT.
  const text = calendar.upcomingReportsText(14, at("2026-10-16T20:30:00Z"));
  assert.match(text, /CFTC Commitments of Traders \(CFTC, impact low\) — RELEASED TODAY at 15:30 ET; it is NOT upcoming/);
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
  assert.equal(budgetcore.allocations(50, 80).analysis, 50, "capped at the budget");
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
  }
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

    // The analysis budget must leave room for everything else; blank returns it to the 20% share.
    r = await post({ monthlyBudgetUsd: "105", analysisBudgetUsd: "200" });
    assert.match(decodeURIComponent(r.location), /must be less than the monthly budget/);
    assert.equal(loadWatchlist().output.analysisBudgetUsd, 45, "a rejected save changes nothing");
    r = await post({ analysisBudgetUsd: "" });
    assert.equal(loadWatchlist().output.analysisBudgetUsd, undefined);
    // "off" still turns a report back to on-demand.
    await post({ analystDay: "off", analystTime: "15:30" });
    assert.equal(loadWatchlist().briefEditions.analyst, undefined);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
