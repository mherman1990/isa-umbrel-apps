// river_stage.js — Mississippi River stage from NOAA/NWS NWPS (api.water.noaa.gov), keyless.
//
// Barge freight is already in the stack via agtransport — but freight is the EFFECT. River STAGE leads
// it by weeks: the low-water autumns of 2022 and 2023 collapsed Gulf export basis before the freight
// prints caught up. Same cause→effect shape the tool already uses for margin→utilization and
// soil-moisture→VCI. This tracks the lower-Mississippi barge-corridor chokepoints the trade watches.
// "markets"-class (Markets tab, not the policy brief).
//
// ⚠️ Gauges sit on DIFFERENT datums, so their absolute feet are NOT comparable across gauges — Memphis
// reads negative at low water while Baton Rouge reads positive on the same day. So these are emitted as
// INDIVIDUAL series, each read against its own history/percentile (which is what "unusually low for
// HERE" needs), NOT a cross-gauge dimension family (§1.3) — a spread across incompatible datums would be
// meaningless. LIDs confirmed against the NWPS API.
//
// NWPS `/stageflow` observed is a ~30-day rolling window (hourly), reduced to a daily-mean series here;
// the store accumulates the longer history over time, the same self-healing shape as the other feeds.

import { fetchJSON, sleep } from "../util.js";

export const id = "river_stage";
export const label = "Mississippi river stage (NWS/NWPS)";

const BASE = "https://api.water.noaa.gov/nwps/v1/gauges";
// Barge-corridor chokepoints, upstream → downstream.
const GAUGES = [
  { lid: "MEMT1", name: "Memphis" },
  { lid: "VCKM6", name: "Vicksburg" },
  { lid: "BTRL1", name: "Baton Rouge" },
  { lid: "NORL1", name: "New Orleans" },
];
const MISSING = -998; // NWPS uses -999 for missing readings

/** Reduce NWPS observed hourly stage → sorted daily-mean [{period:"YYYY-MM-DD", value}]. Pure. */
export function dailyStage(observed) {
  const data = observed?.data ?? [];
  const byDay = new Map();
  for (const p of data) {
    const t = p?.validTime;
    const v = Number(p?.primary);
    if (!t || !Number.isFinite(v) || v <= MISSING) continue;
    const day = String(t).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(v);
  }
  return [...byDay.entries()]
    .map(([period, vs]) => ({ period, value: Math.round((vs.reduce((a, b) => a + b, 0) / vs.length) * 100) / 100 }))
    .sort((a, b) => (a.period < b.period ? -1 : 1));
}

async function gaugeStage(lid) {
  const d = await fetchJSON(`${BASE}/${lid}/stageflow`, { headers: { accept: "application/json" } });
  return dailyStage(d?.observed);
}

/** Returns [{ series, meta, points }] for store.saveSeriesPoints. Fail-soft per gauge. */
export async function fetchSeries() {
  const out = [];
  for (const g of GAUGES) {
    try {
      const pts = await gaugeStage(g.lid);
      if (pts.length) {
        out.push({
          series: `river:ms:${g.lid.toLowerCase()}:stage`,
          meta: { label: `Mississippi at ${g.name} — river stage`, unit: "ft", category: "river_stage" },
          points: pts,
        });
      }
    } catch { /* one gauge failing must not sink the rest */ }
    await sleep(200); // gentle on a free public service
  }
  return out;
}

export async function fetchItems() {
  const parts = [];
  for (const g of GAUGES) {
    try {
      const pts = await gaugeStage(g.lid);
      if (pts.length) parts.push({ name: g.name, ...pts[pts.length - 1] });
    } catch { /* skip this gauge */ }
    await sleep(200);
  }
  if (!parts.length) return [];
  const period = parts.map((p) => p.period).sort().at(-1);
  return [
    {
      uid: `${id}:mississippi:${period}`,
      sourceId: id,
      sourceLabel: label,
      title: `Mississippi river stage — ${parts.map((p) => `${p.name} ${p.value}ft`).join(", ")} (${period})`,
      summary: "NWS/NWPS observed river stage at the Mississippi barge-corridor chokepoints — the leading edge of Gulf export basis.",
      url: "https://water.noaa.gov/",
      publishedAt: new Date(`${period}T00:00:00Z`).toISOString(),
      jurisdiction: "US",
      docType: "data",
      raw: { metric: "river_stage", gauges: parts, period },
    },
  ];
}

export const __test = { dailyStage, GAUGES };
