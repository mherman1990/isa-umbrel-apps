// Tests for the EIA biofuel-feedstock adapter. These lock the double-count fix (soybean/corn/canola oil
// were summing EIA's aggregate "Inputs to Biodiesel Production" code PLUS the standalone RD code, counting
// renewable diesel twice) and the renewable-diesel-share transform. The live query shape is confirmed
// separately against api.eia.gov (scripts/probe-45z-sources).

import test from "node:test";
import assert from "node:assert/strict";

const eia = await import("../src/adapters/eia.js");

test("rdSharePoints: RD share to 0.1%, sorted, skips a period missing a leg", () => {
  const bd = new Map([["2026-05", 800], ["2026-06", 790]]);
  const rd = new Map([["2026-06", 766], ["2026-05", 200], ["2026-08", 500]]);
  assert.deepEqual(eia.__test.rdSharePoints(bd, rd), [
    { period: "2026-05", value: 20 },   // 200 / (800+200)
    { period: "2026-06", value: 49.2 }, // 766 / 1556 = 49.23 → 49.2
  ]); // 2026-08 dropped: no biodiesel leg
});

test("rdSharePoints: [] when total is zero or a leg is absent", () => {
  assert.deepEqual(eia.__test.rdSharePoints(new Map([["p", 0]]), new Map([["p", 0]])), []);
  assert.deepEqual(eia.__test.rdSharePoints(new Map(), new Map([["p", 5]])), []);
});

// The double-count guard: within a single feedstock, no product code may be a prefix of another — that is
// exactly the aggregate-plus-plant-split pattern (EPOOBDSO is a prefix of EPOOBDSOR/EPOOBDSOD) that
// over-counted RD. Re-introducing it fails here rather than silently overstating demand ~49% again.
test("FEEDSTOCKS: no product is a prefix of another in the same feedstock (no aggregate+split double-count)", () => {
  for (const fs of eia.__test.FEEDSTOCKS) {
    for (const a of fs.products) {
      for (const b of fs.products) {
        if (a !== b) assert.ok(!b.startsWith(a), `${fs.key}: ${a} is a prefix of ${b} — aggregate + split double-count`);
      }
    }
  }
});

test("FEEDSTOCKS: soybean/corn/canola oil use the aggregate-only code (RD already included)", () => {
  const byKey = Object.fromEntries(eia.__test.FEEDSTOCKS.map((f) => [f.key, f.products]));
  assert.deepEqual(byKey["soybean-oil"], ["EPOOBDSO"]);
  assert.deepEqual(byKey["corn-oil"], ["EPOOBDCNO"]);
  assert.deepEqual(byKey["canola-oil"], ["EPOOBDCO"]);
});
