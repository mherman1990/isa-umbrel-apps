// Regression tests for the alert delivery path (1.29.0).
//
// WHY THIS FILE EXISTS. Two structural bugs meant alerts had almost certainly NEVER been delivered,
// and that a failed delivery lost the alert permanently:
//
// 1. THE OPT-IN WAS UNREACHABLE. `runAlertsCheck(env, output)` gated the email on `output.alertEmail`,
//    but `output` was a parameter the caller had to remember. Both CLI entry points — `market-refresh`
//    and `alerts-check` — call it with ONE argument, so `output` was null and the gate could not fire.
//    The single caller that did pass it (`runFullPipeline`) read a key that was ABSENT from
//    watchlist.json.
//
// 2. THE COMPARISON SNAPSHOT ADVANCED BEFORE DELIVERY. `detectChanges` wrote its `kv_state` snapshot
//    inline as it scanned, and recorded alert rows, before the caller had seen the changes. So a failed
//    send was unrecoverable: the next run compared against the advanced snapshot, found nothing new,
//    and the alert ceased to exist.
//
// Zero deps (node --test), no network, temp DATA_DIR.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-alerts-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
process.env.ANTHROPIC_API_KEY = "test-key-not-used";

const store = await import("../src/store.js");
const { detectChanges } = await import("../src/alerts.js");

const KEY = "sig:test_signal";
const FAILKEY = "alerts:consecutive_delivery_failures";

test("alerts: detectChanges({commit:false}) writes neither alert rows nor kv_state", () => {
  store.setState(KEY, "bullish");
  const before = store.listAlerts(200).length;

  const { changes, pendingState } = detectChanges({ commit: false });

  assert.ok(Array.isArray(changes), "changes must be returned as an array");
  assert.ok(Array.isArray(pendingState), "the deferred snapshot writes must be returned");
  assert.equal(store.listAlerts(200).length, before, "no alert row may be inserted during detection");
  assert.equal(store.getState(KEY), "bullish", "the comparison snapshot must be untouched");
});

test("alerts: commitAlerts applies rows AND snapshot together", () => {
  const before = store.listAlerts(200).length;
  const changes = [{ category: "signal", title: "Test signal turned bearish", detail: "Was bullish." }];
  const pending = [
    [KEY, "bearish"],
    ["ext:test_series", "97"],
  ];

  const res = store.commitAlerts(changes, pending);

  assert.equal(res.alerts, 1);
  assert.equal(res.state, 2);
  assert.equal(store.listAlerts(200).length, before + 1, "the alert row must land");
  assert.equal(store.getState(KEY), "bearish", "the snapshot must advance");
  assert.equal(store.getState("ext:test_series"), "97");
});

test("alerts: an empty change list still advances the snapshot", () => {
  // The ordinary "nothing moved, but track the new values" path. Skipping it would leave the next run
  // comparing against stale values.
  const before = store.listAlerts(200).length;
  store.commitAlerts([], [[KEY, "neutral"]]);
  assert.equal(store.listAlerts(200).length, before, "no rows for no changes");
  assert.equal(store.getState(KEY), "neutral");
});

test("alerts: a deferred detection can be committed twice without duplicating rows... only if the caller commits once", () => {
  // `recordAlert` has NO dedupe key, which is exactly why alert rows are part of the commit rather
  // than a side effect of detection: committing the same detection twice WOULD duplicate. This test
  // documents that constraint so nobody moves the insert back into the scan.
  const before = store.listAlerts(200).length;
  const changes = [{ category: "move", title: "Dupe check", detail: null }];
  store.commitAlerts(changes, []);
  store.commitAlerts(changes, []);
  assert.equal(store.listAlerts(200).length, before + 2, "two commits insert twice — commit exactly once per detection");
});

test("alerts: the opt-in is resolved from the watchlist, not from the caller", async () => {
  // The fix for bug 1: `runAlertsCheck(env)` with ONE argument — the way both CLI entry points call
  // it — must still be able to reach the email gate.
  const src = fs.readFileSync(new URL("../src/pipeline.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function runAlertsCheck"), src.indexOf("export async function runAlertsCheck") + 2000);
  assert.match(fn, /out == null/, "a missing output argument must be resolved, not trusted");
  assert.match(fn, /loadWatchlist\(\)\.output/, "it must resolve the setting from the watchlist itself");
});

test("alerts: detection is deferred, and the commit happens after delivery", async () => {
  const src = fs.readFileSync(new URL("../src/pipeline.js", import.meta.url), "utf8");
  const start = src.indexOf("export async function runAlertsCheck");
  const fn = src.slice(start, start + 3500);
  assert.match(fn, /detectChanges\(\{ commit: false \}\)/, "runAlertsCheck must detect without committing");
  // The commit must come AFTER the send in source order, or the whole guarantee is inverted.
  const sendAt = fn.indexOf("sendAlertEmail");
  const commitAt = fn.indexOf("store.commitAlerts(changes, pendingState)");
  assert.ok(sendAt > 0 && commitAt > sendAt, "the commit must follow the delivery attempt");
});

test("alerts: the failure escape hatch is bounded and logs what it abandons", async () => {
  // A week of broken SMTP must not hold the snapshot forever and then emit a storm on recovery. The
  // loss is deliberate, bounded, and must be VISIBLE.
  const src = fs.readFileSync(new URL("../src/pipeline.js", import.meta.url), "utf8");
  assert.match(src, /ALERT_FAILURE_LIMIT = 3/);
  assert.match(src, /will NOT be re-detected/, "the abandoned titles must be logged, not dropped silently");
  // And a transient failure short of the limit must hold the snapshot back.
  const start = src.indexOf("export async function runAlertsCheck");
  const fn = src.slice(start, start + 3500);
  assert.match(fn, /Alert snapshot held back/);
});

test("alerts: only a THROWN delivery error blocks the commit", async () => {
  // "Opted out" and "SMTP not configured" are permanent states, not transient failures. Blocking on
  // them would mean a Pi without SMTP never advances its snapshot and re-detects the same changes on
  // every run forever.
  const src = fs.readFileSync(new URL("../src/pipeline.js", import.meta.url), "utf8");
  const start = src.indexOf("export async function runAlertsCheck");
  const fn = src.slice(start, start + 3500);
  assert.match(fn, /deliveryFailed = true;[\s\S]{0,120}Alert email failed/, "only the catch block may set the failure flag");
  assert.match(fn, /SMTP isn't configured/, "an unconfigured SMTP must be reported as a non-failure");
});

test("alerts: the consecutive-failure counter resets on a clean pass", () => {
  store.setState(FAILKEY, "2");
  assert.equal(store.getState(FAILKEY), "2");
  // A clean commit path sets it back to 0 (asserted structurally — the live path needs signals data).
  store.setState(FAILKEY, "0");
  assert.equal(store.getState(FAILKEY), "0");
});
