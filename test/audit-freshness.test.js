// Tests for scripts/audit-freshness.mjs — the read-only freshness audit (Phase 0).
//
// What must hold:
//   1. It diagnoses the storyline failure modes from DB evidence alone (truncation / threw / AM not
//      firing), because the in-app log is an in-memory ring buffer that does not survive a restart.
//   2. It is READ-ONLY: the CLI leaves the database and data dir byte-for-byte unchanged.
//   3. It never prints a key VALUE — presence only.
//   4. It reports the config drift that silently drops item sources (no live watchlist entry).
//
// Zero deps (node --test), no network, temp DATA_DIR.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-audit-"));
process.env.POLIBRIEF_DATA_DIR = DIR;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "scripts", "audit-freshness.mjs");
const store = await import("../src/store.js");
const { auditFreshness, envPresence, renderMarkdown } = await import("../scripts/audit-freshness.mjs");
const Database = (await import("better-sqlite3")).default;
const raw = new Database(store.DB_PATH);

const NOW = new Date("2026-10-04T18:00:00Z");
const LAST_STORY_OK = "2026-09-01T11:40:00.000Z";
const SECRET = "sk-ant-THIS-MUST-NEVER-PRINT-0123456789";

// A live watchlist that predates congress_hearings — the shape an install seeded before 1.22 has.
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, "watchlist.json"), "utf8"));
const live = structuredClone(shipped);
delete live.sources.congress_hearings;
fs.writeFileSync(path.join(DIR, "watchlist.json"), JSON.stringify(live));
fs.writeFileSync(path.join(DIR, ".env"), `ANTHROPIC_API_KEY=${SECRET}\nLEGISCAN_API_KEY=\nCONGRESS_GOV_API_KEY="also-secret"\n`);

// ---- seed the 9/1 storyline failure: AM runs every day since, every storylines call at the cap ----
store.setState("storylines_meta", JSON.stringify({ generatedAt: LAST_STORY_OK, count: 6, moved: 2 }));
raw.prepare("UPDATE kv_state SET updated_at = ? WHERE k = 'storylines_meta'").run(LAST_STORY_OK);
for (let i = 0; i < 6; i++) {
  store.upsertStoryline({ key: `t-${i}`, name: `Thread ${i}`, summary: "s", timeline: [] });
}
raw.prepare("UPDATE storylines SET updated_at = ?").run(LAST_STORY_OK);

const insRun = raw.prepare("INSERT INTO brief_runs (edition, trigger, status, started_at, finished_at) VALUES (?, 'schedule', 'ok', ?, ?)");
const insUse = raw.prepare("INSERT INTO token_usage (ts, model, purpose, input_tokens, output_tokens, run_id) VALUES (?, 'claude-sonnet-5', ?, ?, ?, ?)");
for (let d = new Date("2026-09-02T11:30:00Z"); d < NOW; d = new Date(d.getTime() + 86400e3)) {
  const am = insRun.run("am", d.toISOString(), new Date(d.getTime() + 600e3).toISOString()).lastInsertRowid;
  insUse.run(new Date(d.getTime() + 120e3).toISOString(), "storylines", 11800, 4500, am);
  insUse.run(new Date(d.getTime() + 60e3).toISOString(), "news_digest", 9000, 700, am);
  const pmStart = new Date(d.getTime() + 10 * 3600e3);
  if (pmStart < NOW) insRun.run("pm", pmStart.toISOString(), new Date(pmStart.getTime() + 600e3).toISOString());
}
store.setState("news_digest", JSON.stringify({ date: "2026-10-04", markdown: "x", createdAt: "2026-10-04T11:31:00.000Z", count: 9 }));

// Enough items in the 21-day window that the <3 early return is ruled out.
for (let i = 0; i < 5; i++) {
  store.markSeen({ uid: `fr-${i}`, sourceId: "federal_register", title: `Rule ${i}`, summary: "", url: "https://example.gov", raw: {} }, { relevant: true, topicIds: [], oneLine: "x", tier: "must_read" });
}
raw.prepare("UPDATE seen_items SET first_seen_at = ?").run("2026-10-01T12:00:00.000Z");

// Market inputs: CFTC soybeans current; a new-crop CME pair; barge freight two weeks old.
store.saveSeriesPoints("cftc:soybeans:mm-net", { label: "MM net", unit: "contracts", category: "positioning" }, [
  { period: "2026-09-22", value: 1000 },
  { period: "2026-09-29", value: 1200 },
]);
store.saveSeriesPoints("cme:zs:2026-11", { label: "ZS Nov", unit: "¢/bu", category: "soy_curve" }, [{ period: "2026-10-02", value: 1050 }]);
store.saveSeriesPoints("cme:zc:2026-12", { label: "ZC Dec", unit: "¢/bu", category: "corn_curve" }, [{ period: "2026-10-02", value: 420 }]);
store.saveSeriesPoints("agtransport:barge-freight", { label: "Barge", unit: "$/ton", category: "barge_freight" }, [
  { period: "2026-09-10", value: 30 },
  { period: "2026-09-17", value: 31 },
]);
store.setLastSuccess("federal_register", "2026-10-04T11:30:00.000Z");
store.setLastSuccess("legiscan", "2026-09-20T11:30:00.000Z");
store.setLastSuccess("eurlex_oj", "2026-09-20T11:30:00.000Z");

const run = (extra = {}) =>
  auditFreshness({
    db: raw,
    watchlist: live,
    defaultWatchlist: shipped,
    envPresent: envPresence([path.join(DIR, ".env")], {}),
    dataDir: DIR,
    now: NOW,
    ...extra,
  });

test("storylines: every call since the last success at max_tokens → TRUNCATION verdict, panel flagged", () => {
  const r = run();
  assert.match(r.storylines.verdict, /^TRUNCATION/);
  assert.equal(r.storylines.runsSinceLastSuccess.am > 30, true, "AM runs kept firing after 9/1");
  const p = r.panels.find((x) => x.id === "storylines");
  assert.match(p.status, /^STALE · ATTEMPTS TRUNCATED$/);
  assert.equal(p.attempt.truncatedSinceLastSuccess, p.attempt.callsSinceLastSuccess);
  // The news digest ran in the same runs and persisted — so the run itself was healthy.
  assert.equal(r.panels.find((x) => x.id === "news_digest").status, "OK");
});

test("storylines: AM runs with no recorded call → the THREW verdict (exception before recordUsage)", () => {
  const r = run({ db: withoutPurpose("storylines") });
  assert.match(r.storylines.verdict, /THREW before recordUsage/);
});

test("storylines: no AM run since the last success → the AM-not-firing verdict", () => {
  const db = withoutPurpose("storylines");
  db.prepare("DELETE FROM brief_runs WHERE edition = 'am'").run();
  const r = run({ db });
  assert.match(r.storylines.verdict, /NO AM RUN/);
});

test("sources: an item adapter with no live watchlist entry is reported as NOT collected", () => {
  const r = run();
  const ch = r.sources.find((s) => s.id === "congress_hearings");
  assert.equal(ch.enabled, false);
  assert.match(ch.enabledNote, /NO WATCHLIST ENTRY/);
  assert.ok(r.warnings.some((w) => /congress_hearings/.test(w) && /seedDataDir/.test(w)));
});

test("sources: key presence is reported, and a stale fetch is flagged", () => {
  const r = run();
  const lg = r.sources.find((s) => s.id === "legiscan");
  assert.equal(lg.keyOk, false, "an empty LEGISCAN_API_KEY= line is MISSING, not set");
  assert.equal(lg.status, "NO KEY");
  const fr = r.sources.find((s) => s.id === "federal_register");
  assert.equal(fr.status, "OK");
  const cg = r.sources.find((s) => s.id === "congress_gov");
  assert.equal(cg.keyOk, true, "a quoted value counts as set");
  // Keyless and enabled, last fetched 14 days ago against a 12h pipeline cadence → STALE (fetch).
  const eu = r.sources.find((s) => s.id === "eurlex_oj");
  assert.equal(eu.status, "STALE (fetch)");
});

test("member inputs: CFTC current, meal/oil absent, new-crop CME pair found, barge stale", () => {
  const r = run();
  const by = Object.fromEntries(r.memberInputs.map((m) => [m.id, m]));
  const cftc = by.fund_positioning.rows;
  assert.equal(cftc[0].present && cftc[0].current, true);
  assert.equal(cftc[1].present, false, "no soybean-meal positioning series exists");
  const ratio = by.soy_corn_ratio.rows.find((x) => x.key.startsWith("cme:zs:2026-11"));
  assert.ok(ratio?.present, "Nov soybeans ÷ Dec corn resolves from stored CME contracts");
  assert.equal(by.barge_freight.rows[0].current, false);
});

test("never prints a key value; markdown renders every section", () => {
  const md = renderMarkdown(run());
  assert.ok(!md.includes(SECRET) && !md.includes("also-secret"));
  for (const h of ["## Sources", "## Panels and outputs", "## Storylines — root-cause evidence", "## Member Brief market inputs", "## Scheduler coverage"]) {
    assert.ok(md.includes(h), `missing section ${h}`);
  }
});

test("CLI is read-only: the database and data dir are byte-identical afterwards, and no secret is printed", () => {
  raw.pragma("wal_checkpoint(TRUNCATE)");
  // polibrief.db-shm is excluded on purpose: it is SQLite's WAL *index* (shared-memory read marks), which
  // every reader — read-only connections and the web UI's own page loads included — updates. It holds no
  // data. The database file and the WAL itself must be untouched, and no file may be added or removed.
  const snapshot = () =>
    Object.fromEntries(
      fs.readdirSync(DIR).filter((f) => !f.endsWith("-shm")).sort().map((f) => {
        const p = path.join(DIR, f);
        return [f, fs.statSync(p).isFile() ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") : "dir"];
      })
    );
  const before = snapshot();
  const out = execFileSync(process.execPath, [SCRIPT, "--data-dir", DIR, "--now", NOW.toISOString()], { encoding: "utf8", env: { PATH: process.env.PATH } });
  const after = snapshot();
  assert.deepEqual(after, before, "the audit must not write anything");
  assert.ok(out.includes("TRUNCATION"));
  assert.ok(!out.includes(SECRET) && !out.includes("also-secret"));
  const json = JSON.parse(execFileSync(process.execPath, [SCRIPT, "--data-dir", DIR, "--now", NOW.toISOString(), "--json"], { encoding: "utf8", env: { PATH: process.env.PATH } }));
  assert.equal(json.storylines.verdict.startsWith("TRUNCATION"), true);
});

test("CLI refuses to create a database that does not exist", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "bb-audit-empty-"));
  let code = 0;
  try {
    execFileSync(process.execPath, [SCRIPT, "--data-dir", empty], { stdio: "pipe", env: { PATH: process.env.PATH } });
  } catch (err) {
    code = err.status;
  }
  assert.equal(code, 2);
  assert.deepEqual(fs.readdirSync(empty), [], "fileMustExist: nothing is created");
});

/** A scratch copy of the seeded DB with one purpose's token rows removed. */
function withoutPurpose(purpose) {
  raw.pragma("wal_checkpoint(TRUNCATE)");
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bb-audit-copy-")), "polibrief.db");
  fs.copyFileSync(store.DB_PATH, copy);
  const db = new Database(copy);
  db.prepare("DELETE FROM token_usage WHERE purpose = ?").run(purpose);
  return db;
}

test("a persisted source failure shows after a restart (empty log): FAILING with the stored error", () => {
  const ok = run().sources.find((s) => s.id === "federal_register");
  assert.equal(ok.status, "OK");
  store.recordSourceAttempt("federal_register", "items", "error", { error: "HTTP 502 from api.federalregister.gov" });
  const r = run({ logText: "" }).sources.find((s) => s.id === "federal_register");
  assert.match(r.status, /^FAILING \(1×/);
  assert.match(r.lastError, /HTTP 502 from api\.federalregister\.gov/);
  store.recordSourceAttempt("federal_register", "items", "ok", { count: 3 });
  assert.equal(run().sources.find((s) => s.id === "federal_register").status, "OK", "recovers on the next good fetch");
});

test("a failed item fetch stays visible after a later successful series refresh; pack-driven labels read as at runtime", () => {
  store.recordSourceAttempt("drought_monitor", "items", "error", { error: "HTTP 500 on items" });
  store.recordSourceAttempt("drought_monitor", "series", "ok", { count: 4 });
  const s = run({ logText: "" }).sources.find((x) => x.id === "drought_monitor");
  assert.match(s.status, /^FAILING/);
  assert.match(s.lastError, /last items attempt .* failed: HTTP 500 on items/);
  store.recordSourceAttempt("drought_monitor", "items", "ok", { count: 1 });
  assert.equal(run().sources.find((x) => x.id === "usda_ams").label, "USDA AMS (Iowa cash, basis & feedstuffs)");
});

test("member inputs check the barge segments actually in effect (override, else pack)", () => {
  const keysFor = (wl) => run({ watchlist: wl }).memberInputs.find((m) => m.id === "barge_freight").rows.map((r) => r.key);
  assert.deepEqual(keysFor({ ...live, sources: { ...live.sources, agtransport: { enabled: true, bargeLocations: ["Hardin – Havana"] } } }), ["agtransport:barge-freight:hardin-havana"]);
  assert.equal(keysFor({ ...live, sources: { ...live.sources, agtransport: { enabled: true, bargeLocations: ["St. Louis", "Illinois River"] } } }).length, 5, "legacy default → the pack's five");
});
