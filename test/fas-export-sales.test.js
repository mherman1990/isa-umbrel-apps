// Tests for the USDA FAS Export Sales adapter.
//
// WHY THIS FILE EXISTS. Export sales look like a simple weekly number and are not. Three things go
// wrong quietly, and each has a test here because each would produce a plausible-looking wrong
// answer rather than an error:
//
//   1. THE END-OF-MARKETING-YEAR BLIND SPOT. Current-year figures go to zero because the year's
//      business is finished, while the new crop is being booked in a different field. Measured on
//      the real feed at week ending 2026-07-30: China's currentMYNetSales was 0 while
//      nextMYOutstandingSales stood at 3,111,000 tonnes. Reading only the current year would have
//      reported "China: zero" through August.
//   2. THE MARKETING YEAR IS NOT THE SAME FOR ALL THREE COMMODITIES. Verified against
//      /datareleasedates: soybeans run 1 Sep – 31 Aug, meal and oil run 1 Oct – 30 Sep. A single
//      hardcoded rollover month mis-files two of three commodities for a month a year.
//   3. UNIT MIXING. Every soy row observed carries unitId 1 (metric tons), but the endpoint serves
//      commodities measured in running bales and pounds too, and nothing in the row shape stops a
//      different unit being summed into a tonnes total.
//
// Plus the auth trap: the API documents an `API_KEY` header, answers HTTP 403 `API_KEY_MISSING` to
// it, and actually accepts `X-Api-Key`. That is locked by test so a future "fix" to match the docs
// breaks loudly here rather than silently returning no data on the Pi.
//
// PROVENANCE. Every fixture row below is the real shape returned by
// api.fas.usda.gov/api/esr on 2026-08-10, with the China soybean row for week ending 2026-07-30
// reproduced verbatim. No network, no key, temp DATA_DIR.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-fas-"));
process.env.POLIBRIEF_DATA_DIR = DIR;

const store = await import("../src/store.js");
const fas = await import("../src/adapters/fas_export_sales.js");
const { aggregateWeeks, CHINA } = fas.__testing;

const WEEK = "2026-07-30T00:00:00";

/** The real China soybean row for the last week of MY2026 — the blind-spot case, verbatim. */
const CHINA_ROW = {
  commodityCode: 801,
  countryCode: 5700,
  weeklyExports: 0,
  accumulatedExports: 12291209,
  outstandingSales: 141000,
  grossNewSales: 0,
  currentMYNetSales: 0,
  currentMYTotalCommitment: 12432209,
  nextMYOutstandingSales: 3111000,
  nextMYNetSales: 330000,
  unitId: 1,
  weekEndingDate: WEEK,
};

const row = (over = {}) => ({ ...CHINA_ROW, countryCode: 2010, ...over });

// ── aggregation ───────────────────────────────────────────────────────────────────────────────────

test("per-country rows are summed for the all-destinations total and China is isolated", () => {
  const rows = [
    CHINA_ROW,
    row({ countryCode: 2010, currentMYNetSales: 50000, weeklyExports: 20000, currentMYTotalCommitment: 1000000 }),
    row({ countryCode: 5880, currentMYNetSales: 25000, weeklyExports: 10000, currentMYTotalCommitment: 500000 }),
  ];
  const { all, china } = aggregateWeeks(rows);
  const a = all.get("2026-07-30");
  assert.equal(a.netSales, 75000, "China's 0 plus Mexico 50k plus Japan 25k");
  assert.equal(a.exports, 30000);
  assert.equal(a.commitments, 12432209 + 1000000 + 500000);
  const c = china.get("2026-07-30");
  assert.equal(c.netSales, 0);
  assert.equal(c.commitments, 12432209, "China's own commitments, not the total");
});

test("Hong Kong is NOT folded into China", () => {
  // 5820 is a separate reporting destination. Merging it would overstate mainland demand, and the
  // difference is exactly what a China-tariff card would be reasoning about.
  const { china } = aggregateWeeks([CHINA_ROW, row({ countryCode: 5820, currentMYNetSales: 99999 })]);
  assert.equal(china.get("2026-07-30").netSales, 0, "only countryCode 5700 counts as China");
  assert.equal(CHINA, 5700);
});

test("rows measured in another unit are skipped, never summed into a tonnes total", () => {
  // The same endpoint serves running bales (unitId 2) and pounds (5). Nothing in the row shape stops
  // one being added to a metric-tonne series except this check.
  const { all } = aggregateWeeks([
    row({ currentMYNetSales: 1000, unitId: 1 }),
    row({ countryCode: 2011, currentMYNetSales: 500000, unitId: 2 }),
    row({ countryCode: 2012, currentMYNetSales: 999999, unitId: 5 }),
  ]);
  assert.equal(all.get("2026-07-30").netSales, 1000, "only the metric-ton row is counted");
});

test("an unparseable week-ending date is dropped rather than becoming a bad period key", () => {
  const { all } = aggregateWeeks([row({ weekEndingDate: null }), row({ weekEndingDate: "not a date" }), CHINA_ROW]);
  assert.deepEqual([...all.keys()], ["2026-07-30"]);
});

// ── the end-of-marketing-year blind spot ──────────────────────────────────────────────────────────

test("⚠️ the new-crop book is captured, so the end of a marketing year does not read as a collapse", () => {
  const { china } = aggregateWeeks([CHINA_ROW]);
  const c = china.get("2026-07-30");
  // The whole point: current-year business is finished…
  assert.equal(c.netSales, 0);
  // …while three million tonnes sit on the books for next year. Both are true and only one of them
  // is what a reader needs in August.
  assert.equal(c.nextOutstanding, 3111000);
  assert.equal(c.nextNetSales, 330000);
});

test("fetchItems leads with the new-crop book when the marketing year is nearly over", async () => {
  const restore = stubFetch({
    datareleasedates: [{ commodityCode: 801, marketYear: 2026, marketYearStart: "2025-09-01T00:00:00", marketYearEnd: "2026-08-31T00:00:00", releaseTimeStamp: "2026-08-06T08:30:06" }],
    exports: [CHINA_ROW, row({ countryCode: 2010, currentMYNetSales: 32157, weeklyExports: 346012, currentMYTotalCommitment: 29282421 })],
  });
  try {
    const items = await fas.fetchItems({ env: { FAS_API_KEY: "k" } });
    assert.equal(items.length, 1);
    assert.match(items[0].title, /MY2026 is closing/);
    assert.match(items[0].title, /China has 3,111k t booked for next marketing year/);
    assert.match(items[0].summary, /winding down by design/);
    assert.equal(items[0].raw.china.nextMYOutstanding, 3111000);
    assert.equal(items[0].raw.china.netSales, 0);
  } finally {
    restore();
  }
});

test("mid-marketing-year, the same item reports the ordinary weekly figures instead", async () => {
  const midWeek = "2026-01-15T00:00:00";
  const restore = stubFetch({
    datareleasedates: [{ commodityCode: 801, marketYear: 2026, marketYearStart: "2025-09-01T00:00:00", marketYearEnd: "2026-08-31T00:00:00", releaseTimeStamp: "2026-01-22T08:30:00" }],
    exports: [
      { ...CHINA_ROW, weekEndingDate: midWeek, currentMYNetSales: 400000, weeklyExports: 900000 },
      row({ countryCode: 2010, weekEndingDate: midWeek, currentMYNetSales: 200000, weeklyExports: 300000, currentMYTotalCommitment: 5000000 }),
    ],
  });
  try {
    const items = await fas.fetchItems({ env: { FAS_API_KEY: "k" } });
    assert.doesNotMatch(items[0].title, /closing/);
    assert.match(items[0].title, /600k t net sales/, "600k = China 400k + Mexico 200k");
    assert.match(items[0].title, /China 400k t/);
  } finally {
    restore();
  }
});

// ── the marketing-year calendar is read, not assumed ──────────────────────────────────────────────

test("⚠️ the marketing year is read per commodity — beans roll in September, meal and oil in October", async () => {
  const restore = stubFetch({
    datareleasedates: [
      { commodityCode: 801, marketYear: 2026, marketYearStart: "2025-09-01T00:00:00", marketYearEnd: "2026-08-31T00:00:00", releaseTimeStamp: "2026-08-06T08:30:00" },
      { commodityCode: 901, marketYear: 2026, marketYearStart: "2025-10-01T00:00:00", marketYearEnd: "2026-09-30T00:00:00", releaseTimeStamp: "2026-08-06T08:30:00" },
      { commodityCode: 902, marketYear: 2026, marketYearStart: "2025-10-01T00:00:00", marketYearEnd: "2026-09-30T00:00:00", releaseTimeStamp: "2026-08-06T08:30:00" },
    ],
    exports: [],
  });
  try {
    const cal = await fas.fetchMarketYears({ FAS_API_KEY: "k" });
    assert.equal(cal.get(801).end, "2026-08-31");
    assert.equal(cal.get(901).end, "2026-09-30");
    assert.equal(cal.get(902).end, "2026-09-30", "meal and oil do NOT share the soybean marketing year");
  } finally {
    restore();
  }
});

// ── auth, keys and incremental behaviour ──────────────────────────────────────────────────────────

test("⚠️ the auth header is X-Api-Key — the API's own documented header returns API_KEY_MISSING", async () => {
  let seen = null;
  const restore = stubFetch({ datareleasedates: [], exports: [] }, (url, opts) => { seen = opts?.headers ?? {}; });
  try {
    await fas.fetchMarketYears({ FAS_API_KEY: "secret" });
    assert.equal(seen["X-Api-Key"], "secret");
    assert.equal(seen.API_KEY, undefined, "sending API_KEY instead is what breaks it — see the adapter header note");
  } finally {
    restore();
  }
});

test("no key is a clean skip, not a crash", async () => {
  assert.deepEqual(await fas.fetchSeries({ env: {} }), []);
  assert.deepEqual(await fas.fetchItems({ env: {} }), []);
  assert.equal((await fas.fetchMarketYears({})).size, 0);
});

test("a marketing year that has not opened yet answers empty and must not abort the other years", async () => {
  // Measured: MY2027 returns 200 with []. That is why the new-crop book has to come from the
  // nextMY* fields rather than from fetching the next year.
  const restore = stubFetch({
    datareleasedates: [{ commodityCode: 801, marketYear: 2026, marketYearStart: "2025-09-01T00:00:00", marketYearEnd: "2026-08-31T00:00:00", releaseTimeStamp: "x" }],
    exports: [],
  });
  try {
    const series = await fas.fetchSeries({ env: { FAS_API_KEY: "k" } });
    assert.deepEqual(series, [], "no data is an empty result, not a throw");
  } finally {
    restore();
  }
});

test("marketYearOf labels a week by the marketing year it falls in, per commodity boundary", () => {
  // Beans roll 1 Sep; the MY is named for its ENDING calendar year.
  assert.equal(fas.marketYearOf("2025-09-04", "2025-09-01"), 2026, "first week of MY2026");
  assert.equal(fas.marketYearOf("2026-07-30", "2025-09-01"), 2026, "last week of MY2026");
  assert.equal(fas.marketYearOf("2025-08-28", "2025-09-01"), 2025, "still MY2025, days before the roll");
  // Meal and oil roll 1 Oct, so the same date lands in a different marketing year.
  assert.equal(fas.marketYearOf("2025-09-04", "2025-10-01"), 2025, "September is still the OLD year for meal/oil");
  assert.equal(fas.marketYearOf("2025-10-02", "2025-10-01"), 2026);
});

test("the first run pulls history; once every year is present only the open one is refetched", async () => {
  const years = [];
  // Year-aware stub: each requested marketYear answers with a week that genuinely falls inside it,
  // so stored coverage reflects what was actually fetched.
  const restore = stubFetchByYear(years);
  try {
    const cold = await fas.fetchSeries({ env: { FAS_API_KEY: "k" }, sourceConfig: { historyYears: 4 } });
    assert.deepEqual(years, [2026, 2025, 2024, 2023], "cold start walks back historyYears");
    for (const s of cold) store.saveSeriesPoints(s.series, s.meta, s.points);
    years.length = 0;
    await fas.fetchSeries({ env: { FAS_API_KEY: "k" }, sourceConfig: { historyYears: 4 } });
    assert.deepEqual(years, [2026], "with full coverage stored, only the open marketing year is refetched");
  } finally {
    restore();
  }
});

test("⚠️ a year lost to a transient 500 is BACKFILLED later, not silently abandoned", async () => {
  // This endpoint really does answer HTTP 500 on individual years — observed repeatedly on
  // 2026-08-10, different years each attempt. The first version of the incremental check went
  // incremental as soon as the series was non-empty, so a 500 during the cold start truncated the
  // history permanently: every later run saw "data exists" and refetched only the open year. Nothing
  // looked broken — the series still updated weekly — while the seasonal norms quietly rested on
  // fewer years than asked for, or dropped below the three-year floor and vanished.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-fas-gap-"));
  const res = spawnFresh(dir, 4, [2024]); // MY2024 500s on the first pass only
  assert.deepEqual(res.firstPass, [2026, 2025, 2024, 2023], "the cold start asks for all four");
  assert.ok(!res.coveredAfterFirst.includes(2024), "and MY2024 is genuinely missing afterwards");
  assert.deepEqual(res.secondPass, [2026, 2024], "the next run retries the open year AND the gap");
  assert.ok(res.coveredAfterSecond.includes(2024), "which closes it");
  assert.deepEqual(res.thirdPass, [2026], "and once closed it stops being retried");
});

// ── series shape ──────────────────────────────────────────────────────────────────────────────────

test("China share is a ratio, so it survives the cumulative reset that makes commitments a sawtooth", async () => {
  const restore = stubFetch({
    datareleasedates: [{ commodityCode: 801, marketYear: 2026, marketYearStart: "2025-09-01T00:00:00", marketYearEnd: "2026-08-31T00:00:00", releaseTimeStamp: "x" }],
    exports: [CHINA_ROW, row({ countryCode: 2010, currentMYTotalCommitment: 12432209 })],
  });
  try {
    const series = await fas.fetchSeries({ env: { FAS_API_KEY: "k" }, sourceConfig: { historyYears: 1 } });
    const share = series.find((s) => s.series === "fas:soybeans:china:share");
    assert.ok(share, "the share series is emitted");
    assert.equal(share.points.at(-1).value, 50, "China 12,432,209 of 24,864,418 total = 50%");
    assert.equal(share.meta.unit, "%");
  } finally {
    restore();
  }
});

test("the cumulative series carry a percentile caveat so the signal layer cannot misread them", async () => {
  // A level percentile over a marketing-year-to-date total mostly measures how far into the year we
  // are. pipeline.js is where that warning is attached; a new cumulative series without an entry
  // would silently be ranked as if it were a flow.
  const src = fs.readFileSync(new URL("../src/pipeline.js", import.meta.url), "utf8");
  for (const s of ["fas:soybeans:commitments", "fas:soymeal:commitments", "fas:soyoil:commitments", "fas:soybeans:china:commitments"]) {
    assert.ok(src.includes(`"${s}"`), `${s} needs a PERCENTILE_CAVEATS entry`);
  }
});

test("the adapter is registered — a declared source id with no module behind it fetches nothing", async () => {
  // This is the bug being fixed: `fas_export_sales` sat in SOURCE_CLASS and eventkey.js for months
  // with no adapter, so the tool looked like it watched export demand and never did.
  const { adapters, classOf } = await import("../src/adapters/index.js");
  assert.ok(adapters.fas_export_sales, "registered in the adapter map");
  assert.equal(classOf("fas_export_sales"), "markets");
  assert.equal(typeof adapters.fas_export_sales.fetchSeries, "function");
  assert.equal(typeof adapters.fas_export_sales.fetchItems, "function");
});

/**
 * Run the three-pass backfill scenario against a FRESH store in a child process.
 *
 * store.js opens its database at import time and this file has already imported it, so the "what is
 * covered after each pass" question cannot be asked in-process without the other tests' series
 * bleeding in.
 */
function spawnFresh(dir, historyYears, failYears) {
  const script = `
    const store = await import(${JSON.stringify(new URL("../src/store.js", import.meta.url).href)});
    const fas = await import(${JSON.stringify(new URL("../src/adapters/fas_export_sales.js", import.meta.url).href)});
    const CHINA_ROW = ${JSON.stringify(CHINA_ROW)};
    const weekInMY = (my) => \`\${my - 1}-10-15T00:00:00\`;
    const jsonResponse = (body) => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => body, text: async () => JSON.stringify(body) });
    const fail = new Set(${JSON.stringify(failYears)});
    const tried = new Set();
    const years = [];
    globalThis.fetch = async (url) => {
      const s = String(url);
      if (s.includes("/datareleasedates")) return jsonResponse([{ commodityCode: 801, marketYear: 2026, marketYearStart: "2025-09-01T00:00:00", marketYearEnd: "2026-08-31T00:00:00", releaseTimeStamp: "x" }]);
      const my = Number(/marketYear\\/(\\d+)/.exec(s)[1]);
      years.push(my);
      if (fail.has(my) && !tried.has(my)) { tried.add(my); return { ok: false, status: 500, headers: { get: () => "text/html" }, text: async () => "500", json: async () => ({}) }; }
      return jsonResponse([{ ...CHINA_ROW, weekEndingDate: weekInMY(my) }, { ...CHINA_ROW, countryCode: 2010, currentMYNetSales: 1000, weekEndingDate: weekInMY(my) }]);
    };
    const pass = async () => {
      years.length = 0;
      const out = await fas.fetchSeries({ env: { FAS_API_KEY: "k" }, sourceConfig: { historyYears: ${historyYears} } });
      for (const s of out) store.saveSeriesPoints(s.series, s.meta, s.points);
      return [...years];
    };
    const covered = () => [...fas.coveredMarketYears(store.getSeries("fas:soybeans:net-sales"), "2025-09-01")].sort();
    const firstPass = await pass();  const coveredAfterFirst  = covered();
    const secondPass = await pass(); const coveredAfterSecond = covered();
    const thirdPass = await pass();
    console.log("@@" + JSON.stringify({ firstPass, coveredAfterFirst, secondPass, coveredAfterSecond, thirdPass }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, POLIBRIEF_DATA_DIR: dir },
    encoding: "utf8",
  });
  return JSON.parse(out.split("@@")[1]);
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Stub globalThis.fetch with recorded payload shapes. `onCall(url, opts)` observes each request.
 * Returns a restore function — always call it in a finally, or later tests inherit the stub.
 */
/** A week that genuinely falls inside the given bean marketing year (which runs Sep–Aug). */
const weekInMY = (my) => `${my - 1}-10-15T00:00:00`;

/**
 * Year-aware stub: every requested marketYear answers with a week inside it, so what gets stored
 * reflects what was actually fetched. `failYears` 500s on the first attempt at those years only,
 * which is how the transient-failure backfill is exercised.
 */
function stubFetchByYear(years, failYears = new Set(), commodityCodes = [801]) {
  const real = globalThis.fetch;
  const tried = new Set();
  globalThis.fetch = async (url) => {
    const s = String(url);
    if (s.includes("/datareleasedates")) {
      const body = commodityCodes.map((commodityCode) => ({
        commodityCode,
        marketYear: 2026,
        marketYearStart: "2025-09-01T00:00:00",
        marketYearEnd: "2026-08-31T00:00:00",
        releaseTimeStamp: "x",
      }));
      return jsonResponse(body);
    }
    const my = Number(/marketYear\/(\d+)/.exec(s)?.[1]);
    years.push(my);
    if (failYears.has(my) && !tried.has(my)) {
      tried.add(my);
      return { ok: false, status: 500, headers: { get: () => "text/html" }, text: async () => "500: Server Error", json: async () => ({}) };
    }
    return jsonResponse([
      { ...CHINA_ROW, weekEndingDate: weekInMY(my) },
      { ...CHINA_ROW, countryCode: 2010, currentMYNetSales: 1000, weekEndingDate: weekInMY(my) },
    ]);
  };
  return () => {
    globalThis.fetch = real;
  };
}

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => "application/json" },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function stubFetch({ datareleasedates = [], exports: exportRows = [] }, onCall = () => {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    onCall(url, opts);
    const body = String(url).includes("/datareleasedates") ? datareleasedates : exportRows;
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return () => {
    globalThis.fetch = real;
  };
}
