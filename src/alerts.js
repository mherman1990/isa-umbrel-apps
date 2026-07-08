// alerts.js — event-driven "what changed" detection.
//
// Compares the CURRENT market state against the last snapshot (kv_state) and records an alert
// when something material moves: a signal flips direction, the overall tilt shifts, a series
// hits a multi-year extreme, or a big single-period jump. The first run just seeds state (no
// alerts). Called after each market refresh; also available as the `alerts-check` CLI.

import * as store from "./store.js";
import { computeSignals } from "./signals.js";

const fmt = (v) => (v == null ? "—" : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(Math.round(v * 100) / 100));

export function detectChanges() {
  const news = [];

  // 1. Signal direction flips + overall tilt shift.
  const board = computeSignals();
  for (const s of board.signals) {
    const key = `sig:${s.id}`;
    const prev = store.getState(key);
    if (prev && prev !== s.direction && s.direction !== "neutral") {
      news.push({ category: "signal", title: `${s.name} turned ${s.direction}`, detail: `Was ${prev}. ${s.detail}` });
    }
    store.setState(key, s.direction);
  }
  const prevTilt = store.getState("board:tilt");
  if (prevTilt && prevTilt !== board.tilt) {
    news.push({ category: "tilt", title: `Market tilt shifted: ${prevTilt} → ${board.tilt}`, detail: `${board.bullish} bullish / ${board.bearish} bearish / ${board.neutral} neutral.` });
  }
  store.setState("board:tilt", board.tilt);

  // 2. Series extremes + big single-period moves.
  for (const s of store.marketSnapshot()) {
    if (s.count >= 12) {
      const ek = `ext:${s.series}`;
      const prevPct = Number(store.getState(ek));
      if (Number.isFinite(prevPct)) {
        if (s.percentile >= 99 && prevPct < 99) news.push({ category: "extreme", title: `${s.label} hit a multi-year high`, detail: `${fmt(s.latest.value)} (${s.latest.period}) — ${s.percentile}th percentile of ${s.count} observations.` });
        else if (s.percentile <= 1 && prevPct > 1) news.push({ category: "extreme", title: `${s.label} hit a multi-year low`, detail: `${fmt(s.latest.value)} (${s.latest.period}) — ${s.percentile}th percentile of ${s.count} observations.` });
      }
      store.setState(ek, String(s.percentile));
    }
    const mk = `mv:${s.series}`;
    const prevPeriod = store.getState(mk);
    if (prevPeriod && prevPeriod !== s.latest.period && s.changePct != null && Math.abs(s.changePct) >= 20 && s.count >= 6) {
      news.push({ category: "move", title: `${s.label} ${s.changePct >= 0 ? "jumped" : "dropped"} ${Math.abs(s.changePct).toFixed(0)}%`, detail: `${fmt(s.previous.value)} → ${fmt(s.latest.value)} (${s.latest.period}).` });
    }
    store.setState(mk, s.latest.period);
  }

  for (const a of news) store.recordAlert(a.category, a.title, a.detail);
  return news;
}
