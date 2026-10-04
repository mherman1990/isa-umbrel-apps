// Multi-state step 7: the first-run / state-pack check (src/setup.js) — report, overlay issues, switching.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

delete process.env.STATE_PACK;
const { setupReport, formatSetupReport, availablePacks, writeStatePack } = await import("../src/setup.js");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("the Iowa default is ready when the required key is present, and never prints key values", () => {
  const dir = tmp("bb-setup-");
  const r = setupReport({ dataDir: dir, env: { ANTHROPIC_API_KEY: "sk-ant-secret-value", LEGISCAN_API_KEY: "abc", NASS_API_KEY: "def" } });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.equal(r.pack.stateName, "Iowa");
  assert.deepEqual(r.chain.map((l) => l.id), ["us-national", "us-ia"]);
  assert.equal(r.specSource, "default (no STATE_PACK set)");
  const text = formatSetupReport(r) + JSON.stringify(r);
  assert.ok(!/sk-ant-secret-value|\babc\b|\bdef\b/.test(text), "presence only");
  for (const name of ["Administrative rules", "Map layers", "Registry seed", "AMS cash grain"]) {
    assert.equal(r.checks.find((c) => c.name === name)?.status, "ok", name);
  }
});

test("a missing required key makes the deployment not ready", () => {
  const r = setupReport({ dataDir: tmp("bb-setup-"), env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.name === "Key ANTHROPIC_API_KEY").status, "error");
  assert.match(formatSetupReport(r), /Not ready/);
});

test("overlay keys the pack doesn't have are reported, and a broken overlay is an error, not a crash", () => {
  const dir = tmp("bb-setup-ov-");
  fs.writeFileSync(path.join(dir, "pack-overlay.json"), JSON.stringify({ legacyKey: true }));
  const r = setupReport({ dataDir: dir, env: { ANTHROPIC_API_KEY: "x" } });
  assert.equal(r.checks.find((c) => c.name === "Local overlay").status, "warn");
  assert.match(r.overlayIssues.join(), /legacyKey/);

  fs.writeFileSync(path.join(dir, "pack-overlay.json"), JSON.stringify({ identity: { stateFips: "xx" } }));
  const bad = setupReport({ dataDir: dir, env: { ANTHROPIC_API_KEY: "x" } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /stateFips/.test(e)));
});

test("the base tier is listed but cannot be deployed; switching writes STATE_PACK only for a valid pack", () => {
  const packs = availablePacks();
  assert.ok(packs.find((p) => p.spec === "us-ia@2026.1")?.valid);
  assert.ok(packs.find((p) => p.spec === "us-national@2026.1")?.abstract);

  const dir = tmp("bb-setup-sw-");
  fs.writeFileSync(path.join(dir, ".env"), "ANTHROPIC_API_KEY=x\nSTATE_PACK=us-old\n");
  assert.throws(() => writeStatePack(dir, "us-zz"), /not found/);
  assert.throws(() => writeStatePack(dir, "us-national"), /invalid|base tier/);
  assert.match(fs.readFileSync(path.join(dir, ".env"), "utf8"), /STATE_PACK=us-old/, "untouched after a refused switch");

  writeStatePack(dir, "us-ia@2026.1");
  const env = fs.readFileSync(path.join(dir, ".env"), "utf8");
  assert.match(env, /^STATE_PACK=us-ia@2026\.1$/m);
  assert.equal(env.match(/STATE_PACK=/g).length, 1, "replaced, not appended");
  assert.match(env, /^ANTHROPIC_API_KEY=x$/m);
  assert.match(setupReport({ dataDir: dir, env: {} }).specSource, /STATE_PACK in .*\.env/);
});
