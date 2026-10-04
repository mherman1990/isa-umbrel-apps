// ISA Member Brief (1.40.0) — the "no unsupported claims" contract, pinned.
//
//   structure: fixed section order; update ≤ 3 sentences, enforced by code
//   lint: uncited sentence, number not in the packet, decision language on a proposed action, advice,
//         withheld (stale) token — each rejected
//   staleness: a datum past its allowance is shown with its date or omitted, never silently reused
//   review: may delete and downgrade, never add or raise
//   fail closed: lint failing twice → nothing sent, draft saved, error thrown
//   scheduling: Mon/Wed/Fri, the lookback window, restart dedup
//   market inputs: CFTC fallback query, barge location discovery, new-crop ratio, 3-yr average, COT as-of
//
// Zero deps (node --test), no network — globalThis.fetch is stubbed — temp DATA_DIR.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-member-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
process.env.BRIEF_MODEL = "claude-sonnet-5";
process.env.REVIEW_MODEL = "claude-opus-5-5";
delete process.env.SMTP_HOST;
delete process.env.MEMBER_BRIEF_TO;

const store = await import("../src/store.js");
const mb = await import("../src/memberbrief.js");
const { lintMemberDraft, lintMemberSentence } = await import("../src/policylint.js");
const schedule = await import("../src/schedule.js");
const cftc = await import("../src/adapters/cftc.js");
const ag = await import("../src/adapters/agtransport.js");
const Database = (await import("better-sqlite3")).default;
const raw = new Database(store.DB_PATH);

// Wednesday 2026-10-07, 07:00 CT. Window: Mon 10-05 00:00 CT → Wed 10-07 00:00 CT.
const NOW = new Date("2026-10-07T12:00:00Z");
const TZ = "America/Chicago";

// ---------------------------------------------------------------- seed the store

function seedItem(uid, title, body, url, sourceId = "federal_register") {
  store.markSeen({ uid, sourceId, title, summary: body, url, publishedAt: "2026-10-06T00:00:00Z", raw: {} }, { relevant: true, topicIds: [], oneLine: "", tier: "must_read" });
}
seedItem("fr-1", "EPA proposes 2027-2028 RFS volumes", "EPA proposed renewable volume obligations under docket EPA-HQ-OAR-2026-0123. Comments close Nov. 17.", "https://www.federalregister.gov/d/2026-20001");
seedItem("ia-1", "Iowa DNR final rule on drainage wells", "The Iowa DNR adopted a final rule, effective Oct. 1.", "https://www.legis.iowa.gov/docs/iac/rule/1", "iowa_admin_rules");
raw.prepare("UPDATE seen_items SET comment_deadline = '2026-11-17' WHERE uid = 'fr-1'").run();

const card = (headline, uid, extra = {}) => ({
  headline,
  what_changed: "staff card text",
  posture: { status: "proposed_rule", clock_date: "2026-11-17", clock_label: "comments close", detail: "d" },
  mechanism: { chain: [], terminal: "soy_oil_demand", weak_link: "" },
  evidence: [{ id: `item:${uid}`, kind: "item", key: uid, grade: "primary_source", label: "primary source", title: headline, url: "" }],
  so_what: "s",
  watch_next: { event: "Comment period closes", date: "2026-10-08" },
  ...extra,
});
store.insertPolicyCard({ eventKey: "fr:2026-20001", leadUid: "fr-1", edition: "am", card: card("EPA proposes 2027-28 RFS volumes", "fr-1"), certainty: "proposed", status: "kept" });
store.insertPolicyCard({ eventKey: "iar:1", leadUid: "ia-1", edition: "am", card: card("Iowa drainage-well rule final", "ia-1", { posture: { status: "final_rule", clock_date: "2026-10-01", clock_label: "effective", detail: "d" } }), certainty: "enacted", status: "kept" });
store.insertPolicyCard({ eventKey: "old:1", leadUid: "fr-1", edition: "am", card: card("Already reported Friday", "fr-1"), certainty: "proposed", status: "kept" });
raw.prepare("UPDATE policy_cards SET created_at = '2026-10-06T15:00:00.000Z' WHERE event_key IN ('fr:2026-20001','iar:1')").run();
raw.prepare("UPDATE policy_cards SET created_at = '2026-10-03T15:00:00.000Z' WHERE event_key = 'old:1'").run(); // before the window

const weekly = (end, n, start, step) => Array.from({ length: n }, (_, i) => ({ period: new Date(Date.parse(`${end}T00:00:00Z`) - (n - 1 - i) * 7 * 86400e3).toISOString().slice(0, 10), value: start + i * step }));
store.saveSeriesPoints("cftc:soybeans:mm-net", { label: "MM net", unit: "contracts", category: "positioning" }, weekly("2026-09-29", 60, 10000, 1000));
store.saveSeriesPoints("cftc:soymeal:mm-net", { label: "meal", unit: "contracts", category: "positioning" }, weekly("2026-09-08", 60, -5000, 100)); // 3 weeks stale
store.saveSeriesPoints("cme:zs:2026-11", { label: "ZS Nov", unit: "¢/bu", category: "soy_curve" }, [{ period: "2026-10-05", value: 1040 }, { period: "2026-10-06", value: 1050 }]);
store.saveSeriesPoints("cme:zc:2026-12", { label: "ZC Dec", unit: "¢/bu", category: "corn_curve" }, [{ period: "2026-10-05", value: 420 }, { period: "2026-10-06", value: 425 }]);
store.saveSeriesPoints("ams:ia:meal", { label: "meal", unit: "$/ton", category: "soy_products_cash" }, [{ period: "2026-09-25", value: 300 }, { period: "2026-10-02", value: 310 }]);
store.saveSeriesPoints("ams:ia:oil", { label: "oil", unit: "¢/lb", category: "soy_products_cash" }, [{ period: "2026-09-25", value: 50 }, { period: "2026-10-02", value: 52 }]);
store.saveSeriesPoints(
  "agtransport:barge-freight:st-louis",
  { label: "Barge freight — St. Louis", unit: "$/ton", category: "barge_freight", family: "agtransport:barge-freight" },
  [
    { period: "2023-10-03", value: 20 },
    { period: "2024-10-01", value: 22 },
    { period: "2025-09-30", value: 24 },
    { period: "2026-09-24", value: 30 },
    { period: "2026-10-01", value: 28.5 },
  ]
);

const pk = mb.buildMemberPacket({ now: NOW, tz: TZ });
const idOf = (pred) => [...pk.sources.values()].find(pred)?.id;
const S_FR = idOf((s) => s.title.includes("RFS"));
const S_IA = idOf((s) => s.title.includes("drainage"));
const S_FUND = idOf((s) => s.title.includes("Soybeans, managed money"));
const S_RATIO = idOf((s) => s.title.includes("November 2026 soybeans"));
const S_BARGE = idOf((s) => s.title.includes("St. Louis"));
const P_FR = [...pk.policy.values()].find((p) => p.eventKey === "fr:2026-20001").id;
const P_IA = [...pk.policy.values()].find((p) => p.eventKey === "iar:1").id;

const goodDraft = () => ({
  update: [
    { text: "EPA proposed new renewable fuel volumes, and comments are open.", cites: [S_FR] },
    { text: "Funds added to soybean positions last week.", cites: [S_FUND] },
  ],
  policy: [
    { id: P_FR, whatChanged: { text: "EPA proposed renewable fuel volumes for the next two years.", cites: [S_FR] }, whereItStands: { text: `It is a proposal, and comments close {{${P_FR}_CLOCK}}.`, cites: [S_FR] }, whatItMeans: { text: "Higher volumes would add demand for soybean oil used in biodiesel.", cites: [S_FR] }, next: { text: `The next step is the comment deadline on {{${P_FR}_CLOCK}}.`, cites: [S_FR] } },
    { id: P_IA, whatChanged: { text: "The Iowa DNR adopted a rule on agricultural drainage wells.", cites: [S_IA] }, whereItStands: { text: "The rule is final and in effect.", cites: [S_IA] }, whatItMeans: { text: "Operations with drainage wells should know the rule now applies.", cites: [S_IA] }, next: { text: "No further step is scheduled.", cites: [S_IA] } },
  ],
  markets: {
    fund: [{ text: "Managed money is {{FUND_SOYBEANS_NET}}, {{FUND_SOYBEANS_PCT52}}.", cites: [S_FUND] }],
    oilShare: [],
    ratio: [{ text: "The new-crop ratio is {{RATIO_NEWCROP}}.", cites: [S_RATIO] }],
    barge: [{ text: "St. Louis freight is {{BARGE_ST_LOUIS_RATE}}.", cites: [S_BARGE] }],
  },
});

/** Stub the API: draft calls get `drafts[i]`, review calls get `review`. */
function stub(drafts, review = { sentences: [], bands: [] }) {
  const original = globalThis.fetch;
  const calls = { draft: 0, review: 0, bodies: [] };
  globalThis.fetch = async (_u, init) => {
    const body = JSON.parse(init.body);
    calls.bodies.push(body);
    const isReview = String(body.system?.[0]?.text ?? "").startsWith("You are the adversarial reviewer");
    const payload = isReview ? review : drafts[Math.min(calls.draft, drafts.length - 1)];
    if (isReview) calls.review++;
    else calls.draft++;
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: JSON.stringify(payload) }], usage: { input_tokens: 15000, output_tokens: 1500 }, stop_reason: "end_turn" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}
const files = () => fs.readdirSync(path.join(DIR, "briefings")).sort();

// ---------------------------------------------------------------- packet

test("window: Wed covers Mon–Tue; an item from before the window is not re-reported", () => {
  assert.equal(pk.window.fromDate, "2026-10-05");
  assert.equal(pk.window.toDate, "2026-10-06");
  assert.equal(pk.window.nextEdition, "2026-10-09");
  assert.equal(pk.policy.size, 2, "Friday's card is outside the window");
  // Mon covers Fri–Sun, Fri covers Wed–Thu.
  const mon = mb.memberWindow({ now: new Date("2026-10-05T12:00:00Z"), tz: TZ });
  assert.deepEqual([mon.fromDate, mon.toDate], ["2026-10-02", "2026-10-04"]);
  const fri = mb.memberWindow({ now: new Date("2026-10-09T12:00:00Z"), tz: TZ });
  assert.deepEqual([fri.fromDate, fri.toDate], ["2026-10-07", "2026-10-08"]);
});

test("window: a missed (failed-closed) edition is folded into the next, nothing skipped", () => {
  const lastSent = { windowEnd: "2026-10-05T05:00:00.000Z" }; // Monday's edition was the last SENT
  const fri = mb.memberWindow({ now: new Date("2026-10-09T12:00:00Z"), tz: TZ, lastSent });
  assert.equal(fri.startISO, "2026-10-05T05:00:00.000Z", "Friday reaches back to where Monday's sent window ended");
});

test("staleness: a CFTC series three weeks behind is OMITTED with 'not updated this cycle' and its tokens withheld", () => {
  const fund = pk.markets.get("fund");
  assert.ok(fund.lines.some((l) => /^Soybean meal: not updated this cycle/.test(l)));
  assert.equal(pk.tokens.get("FUND_SOYMEAL_NET").stale, true);
  assert.ok(fund.lines.some((l) => /^Soybean oil: not available this cycle/.test(l)), "a market with no series says so");
  assert.equal(pk.tokens.get("FUND_SOYBEANS_NET").value, "net long 69,000 contracts");
  assert.match(pk.tokens.get("FUND_SOYBEANS_WOW").value, /^up 1,000 contracts/);
  assert.equal(pk.tokens.get("FUND_SOYBEANS_PCT52").value, "100th percentile of the past 52 weeks");
});

test("market inputs: new-crop ratio from Nov soy ÷ Dec corn; oil share from AMS cash (never Yahoo); barge with 3-yr average", () => {
  assert.equal(pk.tokens.get("RATIO_NEWCROP").value, (1050 / 425).toFixed(2));
  assert.match(pk.tokens.get("RATIO_CONTRACTS").value, /November 2026 soybeans ÷ December 2026 corn/);
  assert.match(pk.tokens.get("OILSHARE_BASIS").value, /USDA AMS/);
  assert.equal(pk.tokens.get("BARGE_ST_LOUIS_RATE").value, "$28.50 per ton");
  assert.equal(pk.tokens.get("BARGE_ST_LOUIS_WOW").value, "down $1.50 from the prior week");
  assert.equal(pk.tokens.get("BARGE_ST_LOUIS_AVG3").value, "$22.00 per ton 3-year average for the same week");
});

test("deadlines and what-to-watch are code-rendered with citations", () => {
  assert.equal(pk.deadlines.length, 1);
  assert.equal(pk.deadlines[0].date, "2026-11-17");
  assert.ok(pk.watch.some((w) => w.date === "2026-10-08" && /Comment period closes/.test(w.text)), "a card's dated next event inside the window");
  assert.ok(pk.watch.every((w) => pk.sources.has(w.cite)));
});

// ---------------------------------------------------------------- lint

test("lint: the good draft passes", () => {
  const r = lintMemberDraft(mb.normalizeDraft(goodDraft()), pk);
  assert.deepEqual(r.failures, []);
});

test("lint: an UNCITED sentence is rejected", () => {
  const d = goodDraft();
  d.update.push({ text: "Prices will be volatile this fall.", cites: [] });
  const r = lintMemberDraft(mb.normalizeDraft(d), pk);
  assert.ok(r.failures.some((f) => f.rule === "cite_required"));
});

test("lint: a NUMBER not in the packet is rejected; a token or a quoted identifier passes", () => {
  const bad = lintMemberSentence({ text: "Funds hold 71,500 contracts.", cites: [S_FUND] }, pk, {});
  assert.ok(bad.some((f) => f.rule === "number_unsourced"));
  assert.deepEqual(lintMemberSentence({ text: "Funds are {{FUND_SOYBEANS_NET}}.", cites: [S_FUND] }, pk, {}), []);
  // An identifier verbatim in the cited document passes; the same identifier against an unrelated source fails.
  assert.deepEqual(lintMemberSentence({ text: "The docket is EPA-HQ-OAR-2026-0123.", cites: [S_FR] }, pk, {}), []);
  assert.ok(lintMemberSentence({ text: "The docket is EPA-HQ-OAR-2026-0123.", cites: [S_FUND] }, pk, {}).some((f) => f.rule === "number_unsourced"));
});

test("lint: decision language on a PROPOSED action is rejected; on an In-force action with a primary source it passes", () => {
  const p = pk.policy.get(P_FR);
  const r = lintMemberSentence({ text: "The rule is final.", cites: [S_FR] }, pk, { band: p.band, allowedCites: p.citeIds });
  assert.ok(r.some((f) => f.rule === "proposed_as_decision"));
  const ia = pk.policy.get(P_IA);
  assert.deepEqual(lintMemberSentence({ text: "The rule is in effect.", cites: [S_IA] }, pk, { band: ia.band, allowedCites: ia.citeIds }), []);
});

test("lint: advice, a withheld stale token, an unknown cite and a cross-section cite are all rejected", () => {
  assert.ok(lintMemberSentence({ text: "You should sell beans now.", cites: [S_FUND] }, pk, {}).some((f) => f.rule === "advice"));
  assert.ok(lintMemberSentence({ text: "Meal funds are {{FUND_SOYMEAL_NET}}.", cites: [S_FUND] }, pk, {}).some((f) => f.rule === "token_stale"));
  assert.ok(lintMemberSentence({ text: "Something.", cites: ["S999"] }, pk, {}).some((f) => f.rule === "cite_unknown"));
  const p = pk.policy.get(P_FR);
  assert.ok(lintMemberSentence({ text: "Funds moved.", cites: [S_FUND] }, pk, { allowedCites: p.citeIds }).some((f) => f.rule === "cite_scope"));
});

test("update ≤ 3 sentences is enforced by CODE: five entries → three; a two-sentence entry is split", () => {
  const d = goodDraft();
  d.update = [{ text: "One. Two.", cites: [S_FR] }, { text: "Three.", cites: [S_FR] }, { text: "Four.", cites: [S_FR] }, { text: "Five.", cites: [S_FR] }];
  const n = mb.normalizeDraft(d);
  assert.deepEqual(n.update.map((s) => s.text), ["One.", "Two.", "Three."]);
});

// ---------------------------------------------------------------- review

test("review: may delete and downgrade — and can never raise a band or add text", () => {
  const p2 = mb.buildMemberPacket({ now: NOW, tz: TZ });
  const draft = mb.normalizeDraft(goodDraft());
  const r = mb.applyReview(
    draft,
    {
      sentences: [{ sid: "U2", action: "delete", reason: "x" }, { sid: "INVENTED", action: "keep", reason: "x" }],
      bands: [
        { id: P_IA, action: "downgrade", to: "contested", reason: "x" },
        { id: P_FR, action: "downgrade", to: "contested", reason: "trying to RAISE proposed → contested" },
      ],
    },
    p2
  );
  assert.equal(r.draft.update.length, 1);
  assert.equal(p2.policy.get(P_IA).band, "contested");
  assert.equal(p2.policy.get(P_FR).band, "proposed", "a review cannot raise a band");
  assert.equal(r.downgrades.length, 1);
  assert.equal(mb.sentenceList(r.draft).length, mb.sentenceList(draft).length - 1, "nothing added");
});

// ---------------------------------------------------------------- end to end

test("end to end (preview): section order, numbers substituted by code, sources listed, NOTHING sent", async () => {
  const { calls, restore } = stub([goodDraft()], { sentences: [{ sid: "U2", action: "delete", reason: "x" }], bands: [] });
  try {
    const r = await mb.runMemberBrief({ env: process.env, preview: true, now: NOW });
    assert.equal(r.status, "preview");
    assert.equal(calls.draft, 1);
    assert.equal(calls.review, 1);
    const review = calls.bodies.find((b) => String(b.system[0].text).startsWith("You are the adversarial reviewer"));
    assert.equal(review.model, "claude-opus-5-5");
    assert.ok(!review.tools, "no web search in this edition");
    // The breakpoint sits after the evidence packet: the ~670-token system prompt alone is under the
    // 1,024-token cache minimum and would cache nothing.
    assert.equal(calls.bodies[0].messages[0].content[0].cache_control.type, "ephemeral", "system + packet is the cached prefix");
    const md = fs.readFileSync(r.path, "utf8");
    const order = ["# ISA Member Brief", "## The update", "## Policy & regulatory", "## Markets", "## What to watch", "## Sources"].map((h) => md.indexOf(h));
    assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), `fixed section order: ${order}`);
    assert.ok(md.indexOf("### ⏰ Open comment deadlines") < md.indexOf(`### EPA proposes`), "deadlines first in policy");
    assert.ok(md.includes("**Proposed — NOT final.**"));
    assert.ok(md.includes("net long 69,000 contracts"));
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(md), "every token substituted");
    assert.ok(!md.includes("Funds added to soybean positions"), "the reviewer's deletion is honoured");
    assert.match(md, /## Sources\n\n1\. /);
    assert.ok(md.includes("not updated this cycle"));
    assert.equal(mb.lastSent(), null, "a preview never advances the sent window");
  } finally {
    restore();
  }
});

test("FAIL CLOSED: lint fails on the draft and on the retry → not sent, draft saved, error thrown", async () => {
  const bad = goodDraft();
  bad.update = [{ text: "Funds hold 71,500 contracts and prices will rise.", cites: [S_FUND] }];
  const { calls, restore } = stub([bad, bad]);
  const before = files();
  try {
    await assert.rejects(() => mb.runMemberBrief({ env: { ...process.env, MEMBER_BRIEF_TO: "member@example.org" }, now: NOW }), (err) => err.failedClosed === true && /failed closed/.test(err.message));
    assert.equal(calls.draft, 2, "exactly one retry");
    assert.equal(calls.review, 0, "a draft that fails lint never reaches the reviewer");
    const added = files().filter((f) => !before.includes(f));
    assert.ok(added.some((f) => f.endsWith("-member-draft.md")), "the draft is saved for a human");
    assert.ok(!added.some((f) => /-member\.md$/.test(f)), "no sendable brief written");
    const draft = fs.readFileSync(path.join(DIR, "briefings", added.find((f) => f.endsWith("-member-draft.md"))), "utf8");
    assert.match(draft, /NOT SENT — failed closed/);
    assert.equal(mb.lastSent(), null);
  } finally {
    restore();
  }
});

test("retry: a draft that fails lint, then passes on the retry, is accepted (the failures are fed back)", async () => {
  const bad = goodDraft();
  bad.update = [{ text: "Funds hold 71,500 contracts.", cites: [S_FUND] }];
  const { calls, restore } = stub([bad, goodDraft()]);
  try {
    const r = await mb.runMemberBrief({ env: process.env, preview: true, now: NOW });
    assert.equal(r.attempts, 2);
    assert.match(JSON.stringify(calls.bodies[1].messages), /REJECTED BY CODE/);
  } finally {
    restore();
  }
});

test("budget: past the hard ceiling the Member Brief fails closed without calling the model", async () => {
  store.recordUsage("claude-sonnet-5", "query", 0, 10_000_000); // $100 at $10/MTok
  const { calls, restore } = stub([goodDraft()]);
  try {
    await assert.rejects(() => mb.runMemberBrief({ env: process.env, now: NOW }), /budget|ceiling/);
    assert.equal(calls.draft, 0);
  } finally {
    restore();
    raw.prepare("DELETE FROM token_usage WHERE purpose = 'query'").run();
  }
});

// ---------------------------------------------------------------- scheduling

test("scheduling: Mon/Wed/Fri at 06:45 — and only once a day, even across a restart", () => {
  const ED = { am: "06:30", pm: "16:30", member: "Mon,Wed,Fri 06:45", timezone: TZ };
  const at = (iso) => new Date(iso);
  assert.ok(schedule.dueEditions(ED, at("2026-10-07T11:50:00Z"), new Set(["2026-10-07-am"]), ["member"]).due.includes("member"), "Wed 06:50");
  assert.ok(!schedule.dueEditions(ED, at("2026-10-07T11:40:00Z"), new Set(["2026-10-07-am"]), ["member"]).due.includes("member"), "Wed 06:40 — not yet");
  assert.ok(!schedule.dueEditions(ED, at("2026-10-08T12:00:00Z"), new Set(["2026-10-08-am"]), ["member"]).due.includes("member"), "Thursday");
  // Restart after the Wednesday brief ran: its run row marks it done.
  const ran = schedule.seedRan([{ edition: "member", status: "ok", started_at: "2026-10-07T11:46:00Z" }], ["2026-10-07-member.md"], TZ);
  assert.ok(!schedule.dueEditions(ED, at("2026-10-07T15:00:00Z"), ran, ["member"]).due.includes("member"));
  // A failed-closed edition is not retried in a loop (it alerted; a human looks at it).
  const failed = schedule.seedRan([{ edition: "member", status: "failed", error: "Member Brief failed closed", started_at: "2026-10-07T11:46:00Z" }], ["2026-10-07-member-draft.md"], TZ);
  assert.ok(!schedule.dueEditions(ED, at("2026-10-07T15:00:00Z"), failed, ["member"]).due.includes("member"));
  // A preview is not the edition.
  const preview = schedule.seedRan([{ edition: "member-preview", status: "ok", started_at: "2026-10-07T11:00:00Z" }], ["2026-10-07-member-preview.md"], TZ);
  assert.ok(schedule.dueEditions(ED, at("2026-10-07T12:00:00Z"), preview, ["member"]).due.includes("member"));
});

test("COT as-of: before Friday's 2:30 p.m. ET release the prior week's Tuesday is the newest", () => {
  assert.equal(mb.expectedCotAsOf(new Date("2026-10-09T18:00:00Z")), "2026-09-29", "Fri 2:00 p.m. ET");
  assert.equal(mb.expectedCotAsOf(new Date("2026-10-09T19:00:00Z")), "2026-10-06", "Fri 3:00 p.m. ET");
  assert.equal(mb.expectedCotAsOf(new Date("2026-10-12T11:00:00Z")), "2026-10-06", "the following Monday");
});

test("new-crop ratio rolls to next year's pair after November expiry", () => {
  const get = (k) => ({ "cme:zs:2027-11": [{ period: "2026-11-20", value: 1100 }], "cme:zc:2027-12": [{ period: "2026-11-20", value: 440 }] })[k] ?? [];
  const r = mb.newCropRatio("2026-11-20", get);
  assert.equal(r.year, 2027);
  assert.equal(r.latest.value, 2.5);
});

// ---------------------------------------------------------------- adapters

test("CFTC: falls back to the name-only query when Socrata rejects the code column", async () => {
  const urls = [];
  const fetcher = async (url) => {
    urls.push(url);
    if (url.includes("cftc_contract_market_code")) throw new Error("HTTP 400 no such column");
    return [{ report_date_as_yyyy_mm_dd: "2026-09-29T00:00:00.000", m_money_positions_long_all: "10", m_money_positions_short_all: "4" }];
  };
  const rows = await cftc.__test.rowsFor(cftc.MARKETS[1], 5, fetcher);
  assert.equal(rows.length, 1);
  assert.equal(urls.length, 2);
  assert.deepEqual(cftc.MARKETS.map((m) => m.key), ["soybeans", "soymeal", "soyoil"]);
});

test("barge: location column discovered, rows grouped per wanted location, $/ton", () => {
  assert.equal(ag.findLocationColumn({ date: "x", location: "St. Louis", price_per_ton: "1" }), "location");
  assert.equal(ag.findLocationColumn({ date: "x", river_segment: "Illinois River" }), "river_segment");
  assert.equal(ag.findLocationColumn({ date: "x", price_per_ton: "1" }), null);
  const out = ag.bargeSeriesFromRows([
    { date: "2026-10-01T00:00:00.000", loc: "ST. LOUIS", v: "28.5" },
    { date: "2026-10-01T00:00:00.000", loc: "Illinois River", v: "31" },
    { date: "2026-10-01T00:00:00.000", loc: "Cincinnati", v: "20" },
  ]);
  assert.deepEqual(out.map((s) => s.series).sort(), ["agtransport:barge-freight:illinois-river", "agtransport:barge-freight:st-louis"]);
  assert.equal(out[0].meta.unit, "$/ton");
  assert.equal(out[0].meta.family, "agtransport:barge-freight");
});

test("3-year same-week average needs at least two prior years", () => {
  assert.equal(mb.threeYearAverage([{ period: "2025-10-01", value: 10 }], "2026-10-01"), null);
  assert.deepEqual(mb.threeYearAverage([{ period: "2025-10-03", value: 10 }, { period: "2024-09-28", value: 20 }], "2026-10-01"), { avg: 15, years: 2 });
});
