// signals.js — market signal scoring for The Bean Brief.
//
// Ported/adapted from the isa-market-intel prototype (lib/signals.js), but computed from OUR
// stored market_series via the deep trend snapshot (percentile / YoY / seasonal / change),
// not mock data. Each scorer returns:
//   { id, name, direction: 'bullish'|'bearish'|'neutral', label, detail, value }
// "direction" is the read for the SOYBEAN PRICE: bullish = supportive of price, bearish =
// weighs on it. A scorer returns null when it has no usable data (kept off the board).
//
// This is the shared engine behind the Markets signals board, the Farmer Market Pulse and
// Analyst presets, and the change alerts.

import * as store from "./store.js";
import { weatherSignals } from "./weather.js";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthOf = (period) => MON[(Number(String(period).slice(5, 7)) || 1) - 1];
const pctStr = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
const round = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Math.round(v * 100) / 100);

// A series' latest period is "fresh enough" to score (guards off-season / stale series).
function isFresh(s, maxDays = 120) {
  const m = String(s.latest.period).split("-");
  const t = Date.UTC(+m[0], (+m[1] || 1) - 1, +m[2] || 1);
  return Date.now() - t <= maxDays * 86400e3;
}

// --- individual scorers (each takes the snapshot map) ---

function cropCondition(m) {
  const s = m.get("nass:us:condition") || m.get("nass:ia:condition");
  if (!s || s.seasonalDeltaPct == null || !isFresh(s, 25)) return null; // in-season only
  const d = s.seasonalDeltaPct;
  const direction = d >= 3 ? "bearish" : d <= -3 ? "bullish" : "neutral";
  return {
    id: "crop_condition", name: "Crop Condition", direction, value: s.latest.value,
    label: `${Math.round(s.latest.value)}% G/E`,
    detail: `U.S. soybeans ${Math.round(s.latest.value)}% good/excellent (${s.latest.period}), ${pctStr(d)} vs. the ${monthOf(s.latest.period)} norm. ${direction === "bearish" ? "Above-normal crop weighs on price." : direction === "bullish" ? "Below-normal crop supports price." : "Conditions near normal."}`,
  };
}

function drought(m) {
  const s = m.get("drought_monitor:ia:d1");
  if (!s || !isFresh(s, 21)) return null;
  const chg = s.changeAbs; // change in % area vs prior week
  const direction = chg >= 5 ? "bullish" : chg <= -5 ? "bearish" : s.latest.value >= 40 ? "bullish" : "neutral";
  return {
    id: "drought", name: "Iowa Drought", direction, value: s.latest.value,
    label: `${Math.round(s.latest.value)}% D1+`,
    detail: `${Math.round(s.latest.value)}% of Iowa in drought (${s.latest.period}), ${chg >= 0 ? "▲" : "▼"}${Math.abs(Math.round(chg))}pts wk/wk. ${direction === "bullish" ? "Rising/high stress supports price." : direction === "bearish" ? "Easing drought weighs on price." : "Little change."}`,
  };
}

function exportPace(m) {
  const s = m.get("agtransport:soy-net-export-sales");
  if (!s || s.yoyPct == null || !isFresh(s, 30)) return null;
  const d = s.yoyPct;
  const direction = d >= 15 ? "bullish" : d <= -15 ? "bearish" : "neutral";
  return {
    id: "export_pace", name: "Export Sales Pace", direction, value: s.latest.value,
    label: `${pctStr(d)} YoY`,
    detail: `Weekly soybean net export sales ${round(s.latest.value)} MT (${s.latest.period}), ${pctStr(d)} vs. a year ago. ${direction === "bullish" ? "Demand running ahead of last year." : direction === "bearish" ? "New sales lagging last year — soft demand." : "Sales near last year's pace."}`,
  };
}

function fundPositioning(m) {
  const s = m.get("cftc:soybeans:mm-net");
  if (!s || !isFresh(s, 21)) return null;
  const p = s.percentile; // percentile of net position within its own history
  const direction = p >= 65 ? "bullish" : p <= 35 ? "bearish" : "neutral";
  return {
    id: "fund_positioning", name: "Fund Positioning", direction, value: p,
    label: `${p}th pctile`,
    detail: `CBOT managed-money net ${round(s.latest.value)} contracts (${s.latest.period}) — ${p}th percentile of its range. ${direction === "bullish" ? "Funds leaning long." : direction === "bearish" ? "Funds leaning short — crowded shorts can cover." : "Funds near neutral."}`,
  };
}

function crushDemand(m) {
  const s = m.get("nass:us:crush");
  if (!s || s.percentile == null) return null;
  const p = s.percentile;
  const direction = p >= 80 ? "bullish" : p <= 25 ? "bearish" : "neutral";
  return {
    id: "crush_demand", name: "Crush Demand", direction, value: p,
    label: `${p}th pctile`,
    detail: `U.S. crush ${round(s.latest.value)} (${s.latest.period}), ${s.yoyPct != null ? pctStr(s.yoyPct) + " YoY, " : ""}${p}th percentile of its range. ${direction === "bullish" ? "Record-strong domestic demand supports basis." : direction === "bearish" ? "Soft crush demand." : "Crush demand mid-range."}`,
  };
}

function stocksToUse(m) {
  const s = m.get("wasde:us:soy-stocks-to-use");
  if (!s || !isFresh(s, 75)) return null; // WASDE is monthly; tolerate a skipped release
  const v = s.latest.value; // U.S. ending stocks as a % of total use — the balance-sheet tightness ratio
  // Level-based (meaningful from a single point): a thin cushion is bullish, a fat one bearish.
  const direction = v < 8 ? "bullish" : v > 15 ? "bearish" : "neutral";
  const rel = `${monthOf(s.latest.period)} ${String(s.latest.period).slice(0, 4)}`;
  return {
    id: "stocks_to_use", name: "Stocks-to-Use", direction, value: v,
    label: `${v.toFixed(1)}% S/U`,
    detail: `The ${rel} WASDE puts U.S. soybean ending stocks at ${v.toFixed(1)}% of total use. ${direction === "bullish" ? "A tight balance sheet (below ~8%) leaves little cushion and supports price." : direction === "bearish" ? "An ample balance sheet (above ~15%) is a comfortable cushion that weighs on price." : "A middling balance sheet — neither tight nor burdensome."}`,
  };
}

function feedstockShare(m) {
  const soy = m.get("eia:feedstock:soybean-oil");
  if (!soy || !soy.trail || soy.trail.length < 2) return null;
  // soy oil's share of ALL biofuel feedstock, now vs. the prior point.
  const cats = [...m.values()].filter((s) => s.category === "biofuel_feedstock");
  const totalNow = cats.reduce((a, s) => a + (s.latest?.value || 0), 0);
  const totalPrev = cats.reduce((a, s) => a + (s.previous?.value || 0), 0);
  if (!totalNow || !totalPrev) return null;
  const shareNow = (soy.latest.value / totalNow) * 100;
  const sharePrev = (soy.previous.value / totalPrev) * 100;
  const chg = shareNow - sharePrev;
  const direction = chg <= -1.5 ? "bearish" : chg >= 1.5 ? "bullish" : "neutral";
  return {
    id: "feedstock_share", name: "Soy-Oil Biofuel Share", direction, value: shareNow,
    label: `${shareNow.toFixed(0)}% share`,
    detail: `Soybean oil is ${shareNow.toFixed(0)}% of biofuel feedstock (${soy.latest.period}), ${chg >= 0 ? "▲" : "▼"}${Math.abs(chg).toFixed(1)}pts. ${direction === "bearish" ? "Losing share to competing fats — softer oil demand." : direction === "bullish" ? "Gaining feedstock share." : "Share roughly steady."}`,
  };
}

function brazilSupply(m) {
  const s = m.get("ibge_brazil:soy-production");
  if (!s || s.yoyPct == null) return null;
  const d = s.yoyPct;
  const direction = d >= 3 ? "bearish" : d <= -3 ? "bullish" : "neutral";
  return {
    id: "brazil_supply", name: "Brazil Supply", direction, value: s.latest.value,
    label: `${pctStr(d)} YoY`,
    detail: `Brazil's soybean crop ${(s.latest.value / 1e6).toFixed(1)}M t (${s.latest.period}), ${pctStr(d)} YoY. ${direction === "bearish" ? "A bigger Brazilian crop competes with U.S. exports." : direction === "bullish" ? "A smaller Brazilian crop shifts demand to the U.S." : "Brazil's crop near last year's."}`,
  };
}

function seasonalPrice() {
  // Calendar tendency: does the soy price series' next-month seasonal average sit above or
  // below the current month's? Computed from the full price history.
  const h = store.seriesHistory("nass:us:price");
  if (!h || h.points.length < 24) return null;
  const byMonth = {};
  for (const p of h.points) {
    const mm = Number(String(p.period).slice(5, 7));
    if (!mm) continue;
    (byMonth[mm] = byMonth[mm] || []).push(p.value);
  }
  const avg = (mm) => { const a = byMonth[mm]; return a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };
  const now = new Date().getUTCMonth() + 1;
  const next = (now % 12) + 1;
  const cur = avg(now), nxt = avg(next);
  if (cur == null || nxt == null || !cur) return null;
  const d = ((nxt - cur) / cur) * 100;
  const direction = d >= 1 ? "bullish" : d <= -1 ? "bearish" : "neutral";
  return {
    id: "seasonal", name: "Seasonal Pattern", direction, value: d,
    label: `${MON[now - 1]}→${MON[next - 1]} ${pctStr(d)}`,
    detail: `Historically, prices move ${pctStr(d)} on average from ${MON[now - 1]} to ${MON[next - 1]}. ${direction === "bullish" ? "Seasonal tendency favors firmer prices ahead." : direction === "bearish" ? "Seasonal tendency leans softer near-term." : "No strong seasonal bias."}`,
  };
}

function dollar(m) {
  const s = m.get("fred:usd-broad");
  if (!s || s.percentile == null) return null;
  const p = s.percentile;
  const direction = p >= 70 ? "bearish" : p <= 30 ? "bullish" : "neutral";
  return {
    id: "dollar", name: "U.S. Dollar", direction, value: s.latest.value,
    label: `${p}th pctile`,
    detail: `Broad dollar index ${round(s.latest.value)} (${s.latest.period}), ${p}th percentile of its range${s.changePct != null ? `, ${pctStr(s.changePct)} vs. prior` : ""}. ${direction === "bearish" ? "A strong dollar caps U.S. export competitiveness vs. Brazil." : direction === "bullish" ? "A weaker dollar helps U.S. export competitiveness." : "Dollar mid-range."}`,
  };
}

const SCORERS = [cropCondition, drought, exportPace, fundPositioning, crushDemand, stocksToUse, feedstockShare, brazilSupply, dollar];

/**
 * Compute the current signal board from stored market data.
 * @returns {{ signals: object[], bullish, bearish, neutral, total, tilt: string }}
 */
export function computeSignals() {
  const snapshot = store.marketSnapshot();
  const m = new Map(snapshot.map((s) => [s.series, s]));
  const signals = [...SCORERS.map((fn) => fn(m)), seasonalPrice(), ...weatherSignals(m)].filter(Boolean);
  const bullish = signals.filter((s) => s.direction === "bullish").length;
  const bearish = signals.filter((s) => s.direction === "bearish").length;
  const neutral = signals.filter((s) => s.direction === "neutral").length;
  const net = bullish - bearish;
  const tilt = net >= 2 ? "bullish" : net <= -2 ? "bearish" : "mixed";
  return { signals, bullish, bearish, neutral, total: signals.length, tilt };
}

/** Compact one-line text of the board, for injecting into memo/analyst prompts. */
export function signalsText() {
  const { signals, bullish, bearish, neutral, tilt } = computeSignals();
  if (!signals.length) return "";
  const lines = signals.map((s) => `- ${s.name}: ${s.direction.toUpperCase()} (${s.label}) — ${s.detail}`);
  return `Overall tilt: ${tilt.toUpperCase()} (${bullish} bullish / ${bearish} bearish / ${neutral} neutral).\n${lines.join("\n")}`;
}
