// Phase 1 reliability tests (1.39.0) — the failure modes the Phase 0 audit found, each pinned.
//
//   storylines: null return, thrown error, truncation, recovery — every attempt recorded, nothing
//               silently kept as current, prune runs on every attempt
//   cached panels: a truncated digest is NOT stored as complete
//   scheduler: PM-only day, restart mid-day (quiet AM, interrupted run), multi-day specs, refresh gate
//   model config, budget guard, watchlist migration, stop_reason, source health, calendar coverage
//
// Zero deps (node --test), no network — globalThis.fetch is stubbed — temp DATA_DIR.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-p1-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
process.env.BRIEF_MODEL = "claude-sonnet-5";
process.env.TRIAGE_MODEL = "claude-haiku-4-5";

const store = await import("../src/store.js");
const pipeline = await import("../src/pipeline.js");
const panels = await import("../src/panels.js");
const schedule = await import("../src/schedule.js");
const { thinkingOff } = await import("../src/modelcfg.js");
const budget = await import("../src/budget.js");
const calendar = await import("../src/calendar.js");
const Database = (await import("better-sqlite3")).default;
const raw = new Database(store.DB_PATH);

/** Stub the Anthropic API with a canned response (or a failure). Returns the captured request bodies. */
function stubModel(respond) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_u, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const r = respond(body, calls.length);
    if (r instanceof Error) throw r;
    if (r.status && r.status !== 200) {
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: r.message } }), { status: r.status, headers: { "content-type": "application/json" } });
    }
    return new Response(
      JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: r.text }], usage: r.usage ?? { input_tokens: 1000, output_tokens: 200 }, stop_reason: r.stop_reason ?? "end_turn" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const thread = (key, extra = {}) => ({
  key, name: `Thread ${key}`, focus: "f", whatChanged: "c", stateChange: "advanced", whatIsNew: "n", openQuestions: [],
  nextExpectedEvent: { what: "", when: "", why: "" }, materiality: "monitor", timeline: [{ date: "2026-10-01", event: "e", url: "" }], ...extra,
});
const meta = () => JSON.parse(store.getState("storylines_meta") || "null");

function seedItems(n) {
  for (let i = 0; i < n; i++) {
    store.markSeen(
      { uid: `p1-item-${i}`, sourceId: "federal_register", title: `Action ${i}`, summary: "x", url: `https://example.gov/${i}`, raw: {} },
      { relevant: true, topicIds: [], oneLine: "matters", tier: "must_read" }
    );
  }
}

// ---------------------------------------------------------------- storylines

test("storylines: <3 items → outcome 'empty', no model call, generatedAt untouched", async () => {
  const { calls, restore } = stubModel(() => ({ text: "{}" }));
  try {
    const r = await pipeline.generateStorylines(process.env);
    assert.equal(r, null);
    assert.equal(calls.length, 0, "no tokens spent on an empty window");
    const a = panels.getAttempt("storylines");
    assert.equal(a.lastOutcome, "empty");
    assert.equal(meta()?.generatedAt, undefined, "a null return must not look like a success");
    assert.equal(meta()?.lastOutcome, "empty", "the attempt rides alongside generatedAt in storylines_meta");
  } finally {
    restore();
  }
});

test("storylines: success writes generatedAt + lastOutcome ok, bounded to 6 threads", async () => {
  seedItems(5);
  const many = Array.from({ length: 9 }, (_, i) => thread(`t-${i}`));
  const { calls, restore } = stubModel(() => ({ text: JSON.stringify({ storylines: many }) }));
  try {
    const r = await pipeline.generateStorylines(process.env);
    assert.equal(r.count, pipeline.STORYLINE_MAX_THREADS, "code enforces the thread cap even if the model ignores it");
    assert.equal(calls[0].max_tokens, pipeline.STORYLINE_MAX_TOKENS);
    assert.deepEqual(calls[0].thinking, { type: "disabled" }, "Sonnet 5's thinking-off switch");
    assert.ok(!JSON.stringify(calls[0].output_config.format.schema).includes("whatIsUnchanged"), "the unused field is gone from the schema");
    const m = meta();
    assert.ok(m.generatedAt && m.lastOutcome === "ok" && m.lastAttemptAt);
  } finally {
    restore();
  }
});

test("storylines: TRUNCATION → outcome 'truncated', nothing saved, generatedAt kept, notice says why", async () => {
  const before = meta().generatedAt;
  const nThreads = raw.prepare("SELECT COUNT(*) n FROM storylines").get().n;
  const { restore } = stubModel(() => ({ text: '{"storylines":[{"key":"cut-off-mid', stop_reason: "max_tokens", usage: { input_tokens: 12000, output_tokens: 9000 } }));
  try {
    assert.equal(await pipeline.generateStorylines(process.env), null);
    const a = panels.getAttempt("storylines");
    assert.equal(a.lastOutcome, "truncated");
    assert.equal(meta().generatedAt, before, "the last SUCCESS date must not move");
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM storylines").get().n, nThreads);
    assert.match(panels.attemptNotice("storylines"), /cut off/);
    const row = raw.prepare("SELECT stop_reason FROM token_usage WHERE purpose='storylines' ORDER BY id DESC LIMIT 1").get();
    assert.equal(row.stop_reason, "max_tokens", "truncation is a recorded fact, not an inference from the cap");
  } finally {
    restore();
  }
});

test("storylines: THROWN error → outcome 'error' with the message, rethrown, failures counted", async () => {
  const { restore } = stubModel(() => ({ status: 400, message: "thinking.type: disabled is not supported for this model" }));
  try {
    await assert.rejects(() => pipeline.generateStorylines(process.env));
    const a = panels.getAttempt("storylines");
    assert.equal(a.lastOutcome, "error");
    assert.match(a.lastError, /not supported/);
    assert.equal(a.consecutiveFailures, 2, "truncation then error = two failures in a row");
    assert.match(panels.attemptNotice("storylines"), /2 attempts in a row/);
  } finally {
    restore();
  }
});

test("storylines: prune runs on EVERY attempt, including failed ones", async () => {
  store.upsertStoryline({ key: "t-ancient-ctx", name: "Old", summary: "s", timeline: [], materiality: "context" });
  raw.prepare("UPDATE storylines SET updated_at = ? WHERE key = 't-ancient-ctx'").run(new Date(Date.now() - 45 * 86400e3).toISOString());
  const { restore } = stubModel(() => ({ text: "{", stop_reason: "max_tokens" }));
  try {
    await pipeline.generateStorylines(process.env);
    assert.ok(!raw.prepare("SELECT 1 FROM storylines WHERE key = 't-ancient-ctx'").get(), "a failing run must still age old threads off");
  } finally {
    restore();
  }
});

test("storylines: recovery after failures resets the streak and clears the notice", async () => {
  const { restore } = stubModel(() => ({ text: JSON.stringify({ storylines: [thread("t-back")] }) }));
  try {
    await pipeline.generateStorylines(process.env);
    const a = panels.getAttempt("storylines");
    assert.equal(a.lastOutcome, "ok");
    assert.equal(a.consecutiveFailures, 0);
    assert.equal(panels.attemptNotice("storylines"), "");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------- other cached panels

test("news digest: a truncated answer is NOT stored as a complete digest", async () => {
  store.markSeen({ uid: "p1-news-1", sourceId: "rss", title: "News", summary: "body", url: "", raw: {} }, null);
  store.setState("news_digest", JSON.stringify({ date: "2026-10-01", markdown: "previous good digest", createdAt: "2026-10-01T12:00:00Z", count: 3 }));
  const { restore } = stubModel(() => ({ text: "## Theme one\nHalf a sent", stop_reason: "max_tokens" }));
  try {
    assert.equal(await pipeline.generateNewsDigest(process.env), null);
    assert.equal(pipeline.getCachedNewsDigest().markdown, "previous good digest");
    assert.equal(panels.getAttempt("news_digest").lastOutcome, "truncated");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------- scheduler

const TZ = "America/Chicago";
const ED = { am: "06:30", pm: "16:30", weekly: "Fri 17:00", member: "Mon,Wed,Fri 06:45", timezone: TZ };
const at = (iso) => new Date(iso);

test("scheduler: a PM-only day still runs AM first (so storylines run), then PM", () => {
  // Pi down all morning, back at 17:05 CT on Wed 2026-10-07 (22:05Z). Nothing ran today.
  const { due } = schedule.dueEditions(ED, at("2026-10-07T22:05:00Z"), new Set(), ["weekly", "member"]);
  assert.deepEqual(due, ["am", "pm", "member"], "AM before PM, reports after the refresh");
});

test("scheduler: restart after a QUIET AM (run row, no brief file) does not re-run AM", () => {
  const runs = [{ edition: "am", status: "ok", started_at: "2026-10-07T11:30:00Z" }];
  const ran = schedule.seedRan(runs, [], TZ);
  const { due } = schedule.dueEditions(ED, at("2026-10-07T15:00:00Z"), ran, ["weekly", "member"]);
  assert.ok(!due.includes("am"), "the old file-only seed would have re-run the whole AM edition here");
});

test("scheduler: a run INTERRUPTED by a restart is re-run; a plain failure is not retried", () => {
  const interrupted = [{ edition: "am", status: "failed", error: "interrupted — the app restarted mid-run", started_at: "2026-10-07T11:30:00Z" }];
  assert.ok(schedule.dueEditions(ED, at("2026-10-07T12:00:00Z"), schedule.seedRan(interrupted, [], TZ), []).due.includes("am"));
  const failed = [{ edition: "am", status: "failed", error: "HTTP 500", started_at: "2026-10-07T11:30:00Z" }];
  assert.ok(!schedule.dueEditions(ED, at("2026-10-07T12:00:00Z"), schedule.seedRan(failed, [], TZ), []).due.includes("am"));
});

test("scheduler: markInterruptedRuns closes rows left 'running' by a dead process", () => {
  const id = store.startBriefRun({ edition: "am", trigger: "schedule" });
  store.setCurrentRunId(null);
  assert.ok(store.markInterruptedRuns() >= 1);
  const row = store.getBriefRun(id);
  assert.equal(row.status, "failed");
  assert.match(row.error, /interrupted/);
});

test("scheduler: multi-day specs, and single-day specs unchanged", () => {
  assert.deepEqual(schedule.parseDaySpec("Mon,Wed,Fri 06:45"), { days: ["Mon", "Wed", "Fri"], time: "06:45" });
  assert.deepEqual(schedule.parseDaySpec("Mon, Wed, Fri 6:45"), { days: ["Mon", "Wed", "Fri"], time: "06:45" });
  assert.deepEqual(schedule.parseDaySpec("Fri 17:00"), { days: ["Fri"], time: "17:00" });
  assert.deepEqual(schedule.parseDaySpec("Mon-Fri 07:00").days, ["Mon", "Tue", "Wed", "Thu", "Fri"]);
  for (const bad of ["", "Funday 07:00", "Mon 25:00", 42, null]) assert.equal(schedule.parseDaySpec(bad), null);
  // Tue is not a member day; Mon is.
  assert.ok(!schedule.dueEditions(ED, at("2026-10-06T13:00:00Z"), new Set(["2026-10-06-am"]), ["member"]).due.includes("member"));
  assert.ok(schedule.dueEditions(ED, at("2026-10-05T12:00:00Z"), new Set(["2026-10-05-am"]), ["member"]).due.includes("member"));
});

test("refresh gate: a report needs today's AM/PM refresh to have completed OK", () => {
  assert.equal(schedule.needsRefreshFirst([]), true);
  assert.equal(schedule.needsRefreshFirst([{ edition: "am", status: "failed" }]), true);
  assert.equal(schedule.needsRefreshFirst([{ edition: "am", status: "ok" }]), false);
  assert.equal(schedule.needsRefreshFirst([{ edition: "member", status: "ok" }]), true, "a report is not a refresh");
});

// ---------------------------------------------------------------- model config, budget, migration, health

test("thinkingOff: the right off-switch per model (a .env model upgrade must never 400)", () => {
  assert.deepEqual(thinkingOff({ model: "claude-sonnet-5" }).thinking, { type: "disabled" });
  assert.deepEqual(thinkingOff({ model: "claude-sonnet-5-5" }).thinking, { type: "between_tools" });
  const opus = thinkingOff({ model: "claude-opus-5-5", output_config: { format: { type: "json_schema" } } });
  assert.equal(opus.thinking, undefined);
  assert.equal(opus.output_config.effort, "low");
  assert.ok(opus.output_config.format, "an existing output_config is merged, not clobbered");
  assert.equal(thinkingOff({ model: "claude-haiku-4-5" }).thinking, undefined);
  assert.deepEqual(thinkingOff({ model: "claude-opus-4-8" }).thinking, { type: "disabled" });
});

test("budget: discretionary pauses at its allocation; essential runs to the hard ceiling", () => {
  const now = new Date();
  const env = { MONTHLY_BUDGET_USD: "10" };
  raw.prepare("DELETE FROM token_usage").run();
  // $2.10 of storylines on Sonnet 5 ($2/$10): panels allocation is 20% of $10 = $2.00.
  store.recordUsage("claude-sonnet-5", "storylines", 0, 210_000);
  assert.equal(budget.allow("storylines", { env, now }), false);
  assert.equal(budget.allow("member_brief", { env, now }), true, "essential is not stopped by another group's spend");
  // Push the month past 110% → even essential stops (fail closed).
  store.recordUsage("claude-sonnet-5", "query", 0, 900_000);
  assert.equal(budget.allow("member_brief", { env, now }), false);
  assert.match(budget.check("member_brief", { env, now }).reason, /hard ceiling/);
  const sum = budget.summary({ env, now });
  assert.equal(sum.budget, 10);
  assert.equal(Math.round(budget.GROUPS ? Object.values(budget.GROUPS).reduce((a, g) => a + g.share, 0) * 100 : 0), 100, "shares sum to 100%");
  raw.prepare("DELETE FROM token_usage").run();
});

test("budget: the daily run fails closed at the hard ceiling before any model call", async () => {
  const env = { ...process.env, MONTHLY_BUDGET_USD: "10" };
  raw.prepare("DELETE FROM token_usage").run();
  store.recordUsage("claude-sonnet-5", "query", 0, 1_200_000); // $12 of a $10 month → past 110%
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("no model call may be made past the ceiling");
  };
  try {
    const wl = pipeline.loadWatchlist();
    await assert.rejects(
      pipeline.runFullPipeline({ watchlist: wl, env, edition: "am", kept: [], items: [], skippedSources: [], fetchedCount: 0 }),
      /Budget hard ceiling/
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
    raw.prepare("DELETE FROM token_usage").run();
  }
});

test("budget: a monthly budget set in Settings (watchlist) applies to checks that don't pass the watchlist", () => {
  const wlPath = path.join(DIR, "watchlist.json");
  const before = fs.existsSync(wlPath) ? fs.readFileSync(wlPath, "utf8") : null;
  const wl = JSON.parse(before ?? fs.readFileSync(path.join(store.PROJECT_ROOT, "watchlist.json"), "utf8"));
  wl.output = { ...(wl.output ?? {}), monthlyBudgetUsd: 10 };
  fs.writeFileSync(wlPath, JSON.stringify(wl));
  const env = {}; // no MONTHLY_BUDGET_USD — the watchlist's $10 must win over the $75 default
  raw.prepare("DELETE FROM token_usage").run();
  store.recordUsage("claude-sonnet-5", "query", 0, 1_200_000); // $12: past 110% of $10, far under $75
  try {
    assert.equal(budget.allow("news_digest", { env }), false, "panels see the configured budget");
    assert.match(budget.check("brief", { env }).reason, /hard ceiling \(\$11\.00\)/);
    assert.equal(budget.summary({ env }).budget, 10);
  } finally {
    raw.prepare("DELETE FROM token_usage").run();
    if (before == null) fs.rmSync(wlPath);
    else fs.writeFileSync(wlPath, before);
  }
});

test("budget: discretionary model work stops at its own allocation (ranking per batch, expectations, summaries)", async () => {
  const env = { ...process.env, MONTHLY_BUDGET_USD: "10", ANTHROPIC_API_KEY: "test-key-not-used" };
  raw.prepare("DELETE FROM token_usage").run();
  store.recordUsage("claude-sonnet-5", "storylines", 0, 210_000); // $2.10 > the $2.00 panels allocation
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("no model call may be made past the allocation");
  };
  try {
    assert.equal(budget.allow("brief", { env }), true, "the essential brief is NOT stopped by the panels allocation");
    const { rankNewsItems } = await import("../src/newsrank.js");
    const news = [{ uid: "n-1", sourceId: "rss", title: "Soy news", summary: "x", url: "https://x.test/1", publishedAt: new Date().toISOString() }];
    const r = await rankNewsItems(news, [], env, { log: () => {} });
    assert.equal(r.stats.budgetPaused, true);
    assert.equal(r.verdicts.size, 0);
    const ex = await pipeline.extractExpectations(env);
    assert.match(ex.paused ?? "", /allocation/);
    const { summarizeItem } = await import("../src/summarize.js");
    store.recordUsage("claude-sonnet-5", "query", 0, 140_000); // + $1.40 > the $1.20 Ask/summaries allocation
    await assert.rejects(summarizeItem({ uid: "s-1", title: "t", url: "" }, env), /AI summaries are paused/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
    raw.prepare("DELETE FROM token_usage").run();
  }
});

test("watchlist migration: adds missing source entries, never touches existing ones", () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(store.PROJECT_ROOT, "watchlist.json"), "utf8"));
  const live = structuredClone(shipped);
  delete live.sources.congress_hearings;
  live.sources.legiscan.enabled = false; // the user's own choice
  fs.writeFileSync(path.join(DIR, "watchlist.json"), JSON.stringify(live));
  assert.deepEqual(pipeline.migrateWatchlistSources(), ["congress_hearings"]);
  const after = JSON.parse(fs.readFileSync(path.join(DIR, "watchlist.json"), "utf8"));
  assert.ok(after.sources.congress_hearings);
  assert.equal(after.sources.legiscan.enabled, false, "an existing entry is never overwritten");
  assert.deepEqual(pipeline.migrateWatchlistSources(), [], "idempotent");
});

test("source health: ok / empty / error recorded per source and kind", () => {
  store.recordSourceAttempt("cftc", "series", "ok", { count: 1 });
  store.recordSourceAttempt("cftc", "series", "error", { error: "HTTP 503" });
  store.recordSourceAttempt("cftc", "series", "error", { error: "HTTP 503 again" });
  const row = store.listSourceHealth().find((r) => r.source_id === "cftc" && r.kind === "series");
  assert.equal(row.last_outcome, "error");
  assert.equal(row.consecutive_failures, 2);
  assert.ok(row.last_ok_at && row.last_nonempty_at, "the last good fetch is kept");
  store.recordSourceAttempt("cftc", "series", "empty");
  const r2 = store.listSourceHealth().find((r) => r.source_id === "cftc" && r.kind === "series");
  assert.equal(r2.consecutive_failures, 0);
  assert.equal(r2.last_error, "HTTP 503 again", "the last error survives a later non-error attempt");
});

test("calendar: coverage warns when authored USDA dates end inside 60 days", () => {
  calendar._resetCalendarCache();
  assert.equal(calendar.calendarCoverage(new Date("2026-08-01")).warn, false);
  assert.equal(calendar.calendarCoverage(new Date("2026-11-01")).warn, true, "Dec 10 is the last authored 2026 event");
});
