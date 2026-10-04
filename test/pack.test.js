// State packs (docs/MULTI_STATE.md §2): merge rules, extends chain, validation, overlay, voice, seriesKey.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-pack-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
delete process.env.STATE_PACK;

const { mergePack, resolvePack, validatePack, loadPack, packSpecFromEnv, pack, resetPack, seriesKey, voice, fill, DEFAULT_PACK } = await import("../src/pack.js");

test("mergePack: objects deep-merge, arrays replace, null deletes, {inherit,add,remove} extends", () => {
  const base = { a: { b: 1, c: 2 }, list: [1, 2], hosts: ["x", "y"], gone: 5 };
  const over = { a: { c: 3 }, list: [9], hosts: { inherit: true, add: ["z"], remove: ["x"] }, gone: null };
  assert.deepEqual(mergePack(base, over), { a: { b: 1, c: 3 }, list: [9], hosts: ["y", "z"] });
  assert.deepEqual(base.a, { b: 1, c: 2 }, "pure: base untouched");
});

test("the default pack is Iowa and resolves through us-national with a sha256 per link", () => {
  assert.equal(DEFAULT_PACK, "us-ia");
  const { pack: p, chain } = resolvePack("us-ia");
  assert.deepEqual(chain.map((l) => l.id), ["us-national", "us-ia"]);
  for (const l of chain) assert.match(l.sha256, /^[0-9a-f]{64}$/);
  assert.equal(p.identity.stateName, "Iowa");
  assert.equal(p.identity.stateAlpha, "IA");
  assert.equal(p.prompts.reader, "ISA's Chief Officer for Demand & Policy");
  assert.equal(p.prompts.readerTitle, "Chief Officer for Demand & Policy", "inherited from us-national");
  assert.ok(p.provenance.primaryHosts.includes("legis.iowa.gov"), "us-ia adds state hosts");
  assert.ok(p.provenance.primaryHosts.includes("federalregister.gov"), "inherits the federal hosts");
  assert.equal(p.extends, undefined);
});

test("validatePack lists every problem, including a secret-looking value", () => {
  assert.deepEqual(validatePack(resolvePack("us-ia").pack), []);
  const errs = validatePack({ id: "x", version: "1", identity: { stateAlpha: "Iowa", stateFips: "019", timezone: "Mars/Olympus" }, auth: { apiKey: "sk-live-abc123" } });
  assert.ok(errs.some((e) => /orgName/.test(e)));
  assert.ok(errs.some((e) => /stateAlpha must be two capital letters/.test(e)));
  assert.ok(errs.some((e) => /stateFips must be two digits/.test(e)));
  assert.ok(errs.some((e) => /not a valid IANA time zone/.test(e)));
  assert.ok(errs.some((e) => /apiKey looks like a secret/.test(e)));
  assert.deepEqual(validatePack({ ...resolvePack("us-ia").pack, auth: { apiKey: "LEGISCAN_API_KEY" } }), [], "naming an env var is fine");
});

test("an overlay in the data dir merges last and reports keys the pack doesn't have", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bb-pack-ov-"));
  fs.writeFileSync(path.join(d, "pack-overlay.json"), JSON.stringify({ identity: { orgShort: "IASA" }, renamedThing: 1 }));
  const p = loadPack({ dataDir: d, spec: "us-ia" });
  assert.equal(p.identity.orgShort, "IASA");
  assert.equal(p.identity.stateName, "Iowa");
  assert.equal(p.__meta.overlay, path.join(d, "pack-overlay.json"));
  assert.ok(p.__meta.overlayIssues.some((m) => /renamedThing/.test(m)));
});

test("an overlay that breaks validation stops the load", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bb-pack-bad-"));
  fs.writeFileSync(path.join(d, "pack-overlay.json"), JSON.stringify({ identity: { stateAlpha: "iowa" } }));
  assert.throws(() => loadPack({ dataDir: d, spec: "us-ia" }), /stateAlpha must be two capital letters/);
});

test("STATE_PACK is read from the data .env when the process env lacks it (import-time load order)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bb-pack-env-"));
  fs.writeFileSync(path.join(d, ".env"), "FOO=1\nSTATE_PACK=us-il@2026.1 # comment\n");
  assert.equal(packSpecFromEnv(d), "us-il@2026.1");
  process.env.STATE_PACK = "us-ia";
  try {
    assert.equal(packSpecFromEnv(d), "us-ia", "the process env wins");
  } finally {
    delete process.env.STATE_PACK;
  }
});

test("unknown packs fail loudly", () => {
  assert.throws(() => resolvePack("us-zz"), /not found/);
  assert.throws(() => resolvePack("us-ia@1999.1"), /not found/);
});

test("voice, fill and seriesKey speak for the active pack", () => {
  resetPack();
  assert.equal(pack().identity.stateName, "Iowa");
  const V = voice();
  assert.equal(V.org, "Iowa Soybean Association");
  assert.equal(V.short, "ISA");
  assert.equal(V.aState, "an Iowa");
  assert.equal(V.tz, "America/Chicago");
  assert.equal(fill("{stateName} ({stateAlpha}) — {missing}"), "Iowa (IA) — {missing}");
  assert.equal(seriesKey("nass", "soy-corn-ratio"), "nass:ia:soy-corn-ratio");
  assert.equal(seriesKey("nass", "crush", { scope: "us" }), "nass:us:crush");
});
