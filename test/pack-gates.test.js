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
    legislature: { legiscanHome: "NE", legiscanStates: ["NE"], fullTextStates: ["NE"], openstatesJurisdiction: "Nebraska", chamberNames: null },
  })
);

const { adapters } = await import("../src/adapters/index.js");
const { gradeEvidence } = await import("../src/provenance.js");
const socrata = await import("../src/seed/socrata.js");
const { voice } = await import("../src/pack.js");

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
