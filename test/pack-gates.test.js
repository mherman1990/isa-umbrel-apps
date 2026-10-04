// Multi-state step 5: what a NON-Iowa pack must switch off. Runs in its own process with an overlay that
// re-points the Iowa pack at another state and turns campaign-finance seeding off, so the gates are
// exercised without a second real pack.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-gates-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
delete process.env.STATE_PACK;
fs.writeFileSync(
  path.join(DIR, "pack-overlay.json"),
  JSON.stringify({
    identity: { stateName: "Nebraska", stateAlpha: "NE", stateFips: "31" },
    election: { campaignFinance: { enabled: false } },
    adminRules: null,
    provenance: { primaryHosts: { inherit: true, remove: ["legis.iowa.gov"], add: ["nebraskalegislature.gov"] } },
    markets: { nass: { stateAlpha: "NE" }, ams: { cashReportId: null, feedstuffTradeLoc: null } },
    legislature: { legiscanHome: "NE", legiscanStates: ["NE"], fullTextStates: ["NE"], openstatesJurisdiction: "Nebraska", chamberNames: null },
  })
);

const { adapters } = await import("../src/adapters/index.js");
const { gradeEvidence } = await import("../src/provenance.js");
const socrata = await import("../src/seed/socrata.js");
const { voice, homeRegion, seriesKey } = await import("../src/pack.js");
const ams = await import("../src/adapters/usda_ams.js");
const nass = await import("../src/adapters/usda_nass.js");

test("a state-specific adapter is not registered under another state's pack", () => {
  assert.equal(adapters.iowa_admin_rules, undefined);
  assert.ok(adapters.legiscan && adapters.federal_register, "national adapters stay");
});

test("provenance hosts and primary sources follow the pack", () => {
  assert.notEqual(gradeEvidence({ sourceId: "iowa_admin_rules" }).grade, "primary_source");
  assert.equal(gradeEvidence({ url: "https://nebraskalegislature.gov/bills/x" }).grade, "primary_source");
  assert.notEqual(gradeEvidence({ url: "https://www.legis.iowa.gov/docs/x" }).grade, "primary_source");
  assert.equal(gradeEvidence({ url: "https://www.federalregister.gov/d/1" }).grade, "primary_source", "federal hosts inherited");
});

test("campaign-finance seeding refuses when the pack has it off, even with the env flag set", async () => {
  await assert.rejects(socrata.seed({ env: { IECDB_INFORMATIONAL_USE: "true" }, confirmInformationalUse: true }), /Campaign-finance seeding is off/);
});

test("voice derives the article for the new state", () => {
  assert.equal(voice().aState, "a Nebraska");
  assert.equal(voice().alpha, "NE");
});

test("market adapters follow the pack's state", async () => {
  assert.deepEqual(homeRegion(), { key: "ne", fips: "31", name: "Nebraska" });
  assert.equal(seriesKey("ams", "basis"), "ams:ne:basis");
  assert.equal(ams.label, "USDA AMS (Nebraska cash, basis & feedstuffs)");
  const stateRows = nass.__test.NASS_SERIES.filter((s) => s.params.state_alpha);
  assert.ok(stateRows.length >= 2 && stateRows.every((s) => s.params.state_alpha === "NE" && s.key.startsWith("nass:ne:")));
  // No verified cash-grain report for this state → no request, no items (never another state's report).
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("no network in tests");
  };
  try {
    assert.deepEqual(await ams.fetchItems({ env: {} }), []);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
  // The feedstuff filter matches the state's own trade location, not Iowa's.
  const rows = [
    { report_date: "10/01/2026", "trade Loc": "Iowa", commodity: "Soybean Meal", avg_price: 300 },
    { report_date: "10/01/2026", "trade Loc": "Nebraska", commodity: "Soybean Meal", avg_price: 310 },
  ];
  const meal = ams.__test.feedstuffSeries(rows).out.find((x) => x.series === "ams:ne:meal");
  assert.equal(meal?.points?.[0]?.value, 310);
});

test("LegiScan always searches (and full-text searches) the pack's home state, whatever the shared watchlist lists", async () => {
  const legiscan = await import("../src/adapters/legiscan.js");
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(String(u));
    return new Response(JSON.stringify({ status: "OK", masterlist: {}, searchresult: { summary: { count: 0 } } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    // The shipped watchlist's Iowa-era scope: neighbours listed, full text for IA only.
    await legiscan.fetchItems({ sinceISO: "2026-10-01T00:00:00Z", topics: [], sourceConfig: { states: ["IA", "IL"], fullTextStates: ["IA"] }, env: { LEGISCAN_API_KEY: "k" } }).catch(() => {});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(urls.some((u) => /state=NE\b/.test(u)), `home state searched: ${urls.join(" ")}`);
  assert.ok(urls.findIndex((u) => /state=NE\b/.test(u)) <= urls.findIndex((u) => /state=IA\b/.test(u)) || !urls.some((u) => /state=IA\b/.test(u)), "home state first");
});
