// Tests for eu_ets — the EU ETS carbon price from the CBAM Guide API (official EC CBAM certificate price +
// a daily EUA reference). The fixture is the REAL response shape from https://cbamguide.com/api/cbam-price
// (captured 2026-09-14): a quarterly certificate.series + a certificate.latest, and an ets block whose
// daily reference is currently upstream-stale.

import test from "node:test";
import assert from "node:assert/strict";

const mod = await import("../src/adapters/eu_ets.js");
const { parseCbamPrice } = mod.__test;

const PAYLOAD = {
  certificate: {
    latest: { quarter: "Q2 2026", period: "2026-04-01 to 2026-06-30", price: 75.28, currency: "EUR", unit: "tCO2e", publishedDate: "2026-07-06", source: "European Commission" },
    series: [
      { quarter: "Q1 2026", period: "2026-01-01 to 2026-03-31", price: 75.36, currency: "EUR", unit: "tCO2e", publishedDate: "2026-04-07", source: "European Commission" },
      { quarter: "Q2 2026", period: "2026-04-01 to 2026-06-30", price: 75.28, currency: "EUR", unit: "tCO2e", publishedDate: "2026-07-06", source: "European Commission" },
    ],
    methodology: "Official CBAM certificate price …",
  },
  ets: { price: 80.5, date: "2026-07-22", asOf: "2026-07-22", stale: true, unit: "EUR/tCO2e", note: "…" },
  attribution: { required: true, text: "Source: CBAM Guide (cbamguide.com)" },
};

test("parseCbamPrice backfills the certificate series, deduped with latest and sorted", () => {
  const { cert } = parseCbamPrice(PAYLOAD);
  assert.deepEqual(cert, [
    { period: "2026-04-07", value: 75.36 },
    { period: "2026-07-06", value: 75.28 },
  ]);
});

test("parseCbamPrice skips the daily EUA reference while it is upstream-stale", () => {
  assert.equal(parseCbamPrice(PAYLOAD).daily, null);
});

test("parseCbamPrice captures the daily reference only when ets.stale === false", () => {
  const fresh = { ...PAYLOAD, ets: { price: 78.9, date: "2026-09-14", stale: false, unit: "EUR/tCO2e" } };
  assert.deepEqual(parseCbamPrice(fresh).daily, { period: "2026-09-14", value: 78.9 });
});

test("parseCbamPrice is fail-soft on missing/garbage payloads", () => {
  assert.deepEqual(parseCbamPrice({}), { cert: [], daily: null });
  assert.deepEqual(parseCbamPrice(null), { cert: [], daily: null });
  // A non-ISO date or non-positive price is dropped, not stored.
  const junk = { certificate: { series: [{ publishedDate: "Q1", price: 10 }, { publishedDate: "2026-01-05", price: 0 }] } };
  assert.deepEqual(parseCbamPrice(junk).cert, []);
});

test("parseCbamPrice still yields the certificate point when only certificate.latest is present", () => {
  const onlyLatest = { certificate: { latest: { price: 75.28, publishedDate: "2026-07-06" } } };
  assert.deepEqual(parseCbamPrice(onlyLatest).cert, [{ period: "2026-07-06", value: 75.28 }]);
});

test("fetchSeries maps the parse to store-ready series (stubbed fetch, offline)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(PAYLOAD), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const out = await mod.fetchSeries({ env: {} });
    const byId = Object.fromEntries(out.map((s) => [s.series, s]));
    // stale daily → only the certificate series is emitted
    assert.deepEqual(out.map((s) => s.series), ["euets:cbam-cert"]);
    assert.equal(byId["euets:cbam-cert"].meta.unit, "€/t CO2e");
    assert.equal(byId["euets:cbam-cert"].meta.category, "carbon_prices");
    assert.equal(byId["euets:cbam-cert"].points.length, 2);
    assert.deepEqual(byId["euets:cbam-cert"].points.at(-1), { period: "2026-07-06", value: 75.28 });
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchSeries also emits the daily series when the reference is fresh (stubbed)", async () => {
  const original = globalThis.fetch;
  const fresh = { ...PAYLOAD, ets: { price: 78.9, date: "2026-09-14", stale: false, unit: "EUR/tCO2e" } };
  globalThis.fetch = async () =>
    new Response(JSON.stringify(fresh), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const out = await mod.fetchSeries({ env: {} });
    const daily = out.find((s) => s.series === "euets:daily");
    assert.ok(daily, "daily series present when fresh");
    assert.deepEqual(daily.points, [{ period: "2026-09-14", value: 78.9 }]);
    assert.equal(daily.meta.unit, "€/t CO2e");
  } finally {
    globalThis.fetch = original;
  }
});
