// Tests for the USDA NASS adapter's timeseries config + the unit rescale. These lock the soybean-oil
// stocks/production series to the descriptors confirmed on the Pi (scripts/probe-nass-oil-stocks) and the
// pounds→million-lb scaling. The live api_GET shape is exercised on the Pi (NASS needs a key).

import test from "node:test";
import assert from "node:assert/strict";

const nass = await import("../src/adapters/usda_nass.js");

test("applyScale: pounds → million lb to 0.1 precision; no-op without a scale", () => {
  assert.equal(nass.__test.applyScale(2156713000, 1e-6), 2156.7);
  assert.equal(nass.__test.applyScale(1234, undefined), 1234); // existing series carry no scale
  assert.equal(nass.__test.applyScale(1234, 0), 1234);         // falsy scale = no-op
});

test("soybean-oil series pinned to the confirmed NASS descriptors (commodity OIL, exact short_desc)", () => {
  const byKey = Object.fromEntries(nass.__test.NASS_SERIES.map((s) => [s.key, s]));
  const stocks = byKey["nass:us:soyoil-stocks"];
  const prod = byKey["nass:us:soyoil-production"];
  assert.ok(stocks && prod, "both soybean-oil series present");
  assert.equal(stocks.params.commodity_desc, "OIL");
  assert.equal(stocks.params.short_desc, "OIL, SOYBEAN, ONSITE & OFFSITE, CRUDE - STOCKS, MEASURED IN LB");
  assert.equal(prod.params.short_desc, "OIL, SOYBEAN, CRUDE - PRODUCTION, MEASURED IN LB");
  assert.equal(stocks.unit, "M lb");
  assert.equal(stocks.scale, 1e-6);
});
