// test/modelcfg.test.js — unit tests for thinkingOff() and resolveThinkingMode().
//
// WHY THIS FILE EXISTS (GitHub #42). The original thinkingOff() used a complex overlapping
// regex chain with a silent fallthrough default of {type:"disabled"}. Several models reject
// that param with HTTP 400, and every call site wraps the error in a try/catch that only logs,
// so a wrong branch meant silent breakage of ALL AI features on a model upgrade.
//
// The fix is an explicit THINKING_MODE_TABLE (first-prefix-wins). These tests lock down every
// entry so a model addition, removal, or rename produces a clear test failure rather than a
// silent 400 in production.

import test from "node:test";
import assert from "node:assert/strict";
import { thinkingOff, thinkingOffFields, resolveThinkingMode, THINKING_MODE_TABLE } from "../src/modelcfg.js";

// ── resolveThinkingMode ────────────────────────────────────────────────────────

test("modelcfg: claude-sonnet-5-5 → between_tools", () => {
  assert.equal(resolveThinkingMode("claude-sonnet-5-5"), "between_tools");
  assert.equal(resolveThinkingMode("claude-sonnet-5-5-20261201"), "between_tools");
});

test("modelcfg: claude-opus-5-5 → effort_low", () => {
  assert.equal(resolveThinkingMode("claude-opus-5-5"), "effort_low");
});

test("modelcfg: claude-fable → effort_low", () => {
  assert.equal(resolveThinkingMode("claude-fable"), "effort_low");
  assert.equal(resolveThinkingMode("claude-fable-20261201"), "effort_low");
});

test("modelcfg: claude-mythos → effort_low", () => {
  assert.equal(resolveThinkingMode("claude-mythos"), "effort_low");
});

test("modelcfg: claude-haiku-* → omit", () => {
  assert.equal(resolveThinkingMode("claude-haiku-4-5"), "omit");
  assert.equal(resolveThinkingMode("claude-haiku-3"), "omit");
  assert.equal(resolveThinkingMode("claude-haiku"), "omit");
});

test("modelcfg: claude-3-* → omit", () => {
  assert.equal(resolveThinkingMode("claude-3-opus"), "omit");
  assert.equal(resolveThinkingMode("claude-3-5-sonnet"), "omit");
});

test("modelcfg: pre-4.6 sonnet models → omit", () => {
  assert.equal(resolveThinkingMode("claude-sonnet-4-5"), "omit");
  assert.equal(resolveThinkingMode("claude-sonnet-4-1"), "omit");
});

test("modelcfg: pre-4.6 opus models → omit", () => {
  assert.equal(resolveThinkingMode("claude-opus-4-5"), "omit");
  assert.equal(resolveThinkingMode("claude-opus-4-1"), "omit");
});

test("modelcfg: claude-sonnet-4-6 → disabled", () => {
  assert.equal(resolveThinkingMode("claude-sonnet-4-6"), "disabled");
  assert.equal(resolveThinkingMode("claude-sonnet-4-6-20260901"), "disabled");
});

test("modelcfg: claude-opus-4-6, 4-7, 4-8 → disabled", () => {
  assert.equal(resolveThinkingMode("claude-opus-4-6"), "disabled");
  assert.equal(resolveThinkingMode("claude-opus-4-7"), "disabled");
  assert.equal(resolveThinkingMode("claude-opus-4-8"), "disabled");
});

test("modelcfg: claude-sonnet-5 (not 5-5) → disabled", () => {
  // Critical ordering test: sonnet-5-5 must resolve to between_tools, NOT disabled.
  assert.equal(resolveThinkingMode("claude-sonnet-5"), "disabled");
  assert.equal(resolveThinkingMode("claude-sonnet-5-20261201"), "disabled");
  assert.notEqual(resolveThinkingMode("claude-sonnet-5-5"), "disabled");
});

test("modelcfg: claude-opus-5 (not 5-5) → disabled", () => {
  assert.equal(resolveThinkingMode("claude-opus-5"), "disabled");
  assert.notEqual(resolveThinkingMode("claude-opus-5-5"), "disabled");
});

test("modelcfg: unrecognised model → omit (safe default) with a console.warn", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const mode = resolveThinkingMode("claude-nova-9000");
    assert.equal(mode, "omit", "unknown model must fall back to omit, not disabled");
    assert.ok(warnings.length > 0, "a warning must be emitted for an unknown model");
    assert.ok(warnings[0].includes("claude-nova-9000"), "warning must name the unrecognised model");
    assert.ok(warnings[0].includes("THINKING_MODE_TABLE"), "warning must say where to add it");
  } finally {
    console.warn = originalWarn;
  }
});

test("modelcfg: empty string → omit with warning (not a 400-causing disabled)", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(resolveThinkingMode(""), "omit");
    assert.ok(warnings.length > 0);
  } finally {
    console.warn = originalWarn;
  }
});

// ── thinkingOff() — request mutation ──────────────────────────────────────────

test("modelcfg: thinkingOff sets between_tools for sonnet-5-5", () => {
  const req = { model: "claude-sonnet-5-5", max_tokens: 1000 };
  thinkingOff(req);
  assert.deepEqual(req.thinking, { type: "between_tools" });
  assert.equal(req.max_tokens, 1000, "other fields must not be touched");
});

test("modelcfg: thinkingOff sets effort:low and no thinking field for opus-5-5", () => {
  const req = { model: "claude-opus-5-5", max_tokens: 1000 };
  thinkingOff(req);
  assert.ok(!("thinking" in req), "thinking must not be set for effort_low models");
  assert.equal(req.output_config?.effort, "low");
});

test("modelcfg: thinkingOff merges effort:low into an existing output_config", () => {
  const req = { model: "claude-fable", output_config: { format: { type: "json_schema", schema: {} } } };
  thinkingOff(req);
  assert.equal(req.output_config.effort, "low");
  assert.ok(req.output_config.format, "existing output_config fields must be preserved");
});

test("modelcfg: thinkingOff sets disabled for claude-sonnet-5", () => {
  const req = { model: "claude-sonnet-5", max_tokens: 1000 };
  thinkingOff(req);
  assert.deepEqual(req.thinking, { type: "disabled" });
});

test("modelcfg: thinkingOff omits thinking param for haiku (omit mode)", () => {
  const req = { model: "claude-haiku-4-5", thinking: { type: "enabled" } };
  thinkingOff(req);
  assert.ok(!("thinking" in req), "thinking must be deleted for omit-mode models");
});

test("modelcfg: thinkingOff deletes a pre-existing thinking field before setting the new one", () => {
  const req = { model: "claude-sonnet-5-5", thinking: { type: "disabled" }, max_tokens: 500 };
  thinkingOff(req);
  assert.deepEqual(req.thinking, { type: "between_tools" }, "old disabled value must be replaced");
});

test("modelcfg: thinkingOff returns the same request object (for chaining)", () => {
  const req = { model: "claude-sonnet-5" };
  const returned = thinkingOff(req);
  assert.equal(returned, req, "thinkingOff must return the same object reference");
});

// ── thinkingOffFields() ────────────────────────────────────────────────────────

test("modelcfg: thinkingOffFields returns spreadable fields without the model key", () => {
  const fields = thinkingOffFields("claude-sonnet-5");
  assert.deepEqual(fields.thinking, { type: "disabled" });
  assert.ok(!("model" in fields), "the model key must not appear in the spread result");
});

test("modelcfg: thinkingOffFields merges output_config without clobbering existing keys", () => {
  const existingConfig = { format: { type: "json_schema", schema: {} } };
  const fields = thinkingOffFields("claude-opus-5-5", existingConfig);
  assert.equal(fields.output_config?.effort, "low");
  assert.ok(fields.output_config?.format, "existing format key must survive");
  assert.ok(!("model" in fields));
});

// ── Table integrity ────────────────────────────────────────────────────────────

test("modelcfg: THINKING_MODE_TABLE has no duplicate prefixes", () => {
  const prefixes = THINKING_MODE_TABLE.map((e) => e.prefix);
  const unique = new Set(prefixes);
  assert.equal(unique.size, prefixes.length, "duplicate prefixes cause silent shadowing");
});

test("modelcfg: all entries have a valid mode", () => {
  const VALID_MODES = new Set(["between_tools", "effort_low", "omit", "disabled"]);
  for (const { prefix, mode } of THINKING_MODE_TABLE) {
    assert.ok(VALID_MODES.has(mode), `entry for "${prefix}" has unknown mode "${mode}"`);
  }
});

test("modelcfg: sonnet-5-5 entry appears before sonnet-5 in the table", () => {
  const idxSpecific = THINKING_MODE_TABLE.findIndex((e) => e.prefix === "claude-sonnet-5-5");
  const idxGeneral  = THINKING_MODE_TABLE.findIndex((e) => e.prefix === "claude-sonnet-5");
  assert.ok(idxSpecific < idxGeneral, "more-specific prefix must appear first or sonnet-5-5 resolves as 'disabled'");
});

test("modelcfg: opus-5-5 entry appears before opus-5 in the table", () => {
  const idxSpecific = THINKING_MODE_TABLE.findIndex((e) => e.prefix === "claude-opus-5-5");
  const idxGeneral  = THINKING_MODE_TABLE.findIndex((e) => e.prefix === "claude-opus-5");
  assert.ok(idxSpecific < idxGeneral, "more-specific prefix must appear first");
});
