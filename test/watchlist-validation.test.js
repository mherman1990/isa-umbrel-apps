// test/watchlist-validation.test.js — #49: validateWatchlist() regression tests.
// Verifies that every silent failure mode produces a named warning rather than a zero-score mystery.
import test from "node:test";
import assert from "node:assert/strict";
import { validateWatchlist } from "../src/pipeline.js";

const KNOWN = ["federal_register", "legiscan", "congress_gov", "rss"];

function area(over = {}) {
  return { id: "biofuels", label: "Biofuels", terms: ["45Z", "RFS"], weight: 8, ...over };
}

test("watchlist-validation: a well-formed focus area has no warnings", () => {
  const warnings = validateWatchlist({ focusAreas: [area()] }, KNOWN);
  assert.equal(warnings.length, 0);
});

test("watchlist-validation: missing terms produces a warning", () => {
  const w = validateWatchlist({ focusAreas: [area({ terms: [] })] }, KNOWN);
  assert.ok(w.some(x => x.message.includes("no search terms")), "should warn about empty terms");
});

test("watchlist-validation: null/undefined terms produces a warning", () => {
  const w = validateWatchlist({ focusAreas: [area({ terms: undefined })] }, KNOWN);
  assert.ok(w.some(x => x.message.includes("no search terms")));
});

test("watchlist-validation: non-numeric weight produces a warning", () => {
  const w = validateWatchlist({ focusAreas: [area({ weight: "high" })] }, KNOWN);
  assert.ok(w.some(x => x.message.includes("invalid weight")));
});

test("watchlist-validation: weight below 1 produces a warning", () => {
  const w = validateWatchlist({ focusAreas: [area({ weight: 0 })] }, KNOWN);
  assert.ok(w.some(x => x.message.includes("invalid weight")));
});

test("watchlist-validation: NaN weight produces a warning", () => {
  const w = validateWatchlist({ focusAreas: [area({ weight: NaN })] }, KNOWN);
  assert.ok(w.some(x => x.message.includes("invalid weight")));
});

test("watchlist-validation: missing id produces a warning", () => {
  const w = validateWatchlist({ focusAreas: [area({ id: undefined })] }, KNOWN);
  assert.ok(w.some(x => x.areaId === null && x.message.includes("missing an id")));
});

test("watchlist-validation: duplicate ids are flagged", () => {
  const w = validateWatchlist({ focusAreas: [area({ id: "dup" }), area({ id: "dup" })] }, KNOWN);
  assert.ok(w.some(x => x.message.includes("Duplicate") && x.message.includes("dup")));
});

test("watchlist-validation: unknown appliesTo source ids are flagged", () => {
  const w = validateWatchlist({ focusAreas: [area({ appliesTo: ["federal_register", "nonexistent_source"] })] }, KNOWN);
  assert.ok(w.some(x => x.message.includes("nonexistent_source")));
});

test("watchlist-validation: known appliesTo ids produce no warning", () => {
  const w = validateWatchlist({ focusAreas: [area({ appliesTo: ["federal_register", "legiscan"] })] }, KNOWN);
  assert.equal(w.filter(x => x.message.includes("appliesTo")).length, 0);
});

test("watchlist-validation: empty focusAreas array produces no warnings", () => {
  assert.equal(validateWatchlist({ focusAreas: [] }, KNOWN).length, 0);
});

test("watchlist-validation: validation never throws — even on completely malformed input", () => {
  assert.doesNotThrow(() => validateWatchlist({ focusAreas: [null, undefined, {}, { id: "x", terms: null, weight: "bad" }] }, KNOWN));
});
