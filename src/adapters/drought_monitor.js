// drought_monitor.js — U.S. Drought Monitor (droughtmonitor.unl.edu data services), keyless.
//
// Iowa drought coverage: share of state land area in drought (D1 or worse) and abnormally
// dry or worse (D0+), weekly. A fast read on growing-season crop stress in the Corn Belt —
// the domestic yield-risk companion to the Open-Meteo weather read. "markets"-class item
// (Markets tab, not the policy brief).
//
// API note: the percent-area endpoint wants a state FIPS as `aoi` (Iowa = 19) and M/D/YYYY
// dates; it returns rows newest-first, and d0..d4 are CUMULATIVE ("D1 or worse" = d1).

import { fetchJSON } from "../util.js";
import { homeRegion } from "../pack.js";

export const id = "drought_monitor";
export const label = "U.S. Drought Monitor";

const BASE = "https://usdmdataservices.unl.edu/api/StateStatistics/GetDroughtSeverityStatisticsByAreaPercent";
const HOME = homeRegion(); // the pack's state
const START = "1/1/2015";

const mdy = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;

async function fetchHome() {
  const url = `${BASE}?aoi=${HOME.fips}&startdate=${START}&enddate=${mdy(new Date())}&statisticsType=1`;
  const rows = await fetchJSON(url, { headers: { Accept: "application/json" } });
  return (rows ?? [])
    .filter((r) => r.validStart && r.d0 != null)
    .map((r) => ({ period: String(r.validStart).slice(0, 10), d0: Number(r.d0), d1: Number(r.d1) }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

export async function fetchItems() {
  let pts;
  try {
    pts = await fetchHome();
  } catch {
    return []; // fail-soft
  }
  if (!pts.length) return [];
  const last = pts[pts.length - 1];
  return [
    {
      uid: `${id}:iowa:${last.period}`,
      sourceId: id,
      sourceLabel: label,
      title: `${HOME.name} drought — ${last.d1.toFixed(0)}% of the state in drought (D1+), ${last.d0.toFixed(0)}% abnormally dry or worse (week of ${last.period})`,
      summary: `U.S. Drought Monitor — share of ${HOME.name} land area by drought category (cumulative).`,
      url: `https://droughtmonitor.unl.edu/CurrentMap/StateDroughtMonitor.aspx?${HOME.key.toUpperCase()}`,
      publishedAt: new Date(last.period).toISOString(),
      jurisdiction: HOME.name,
      docType: "data",
      raw: { metric: "drought", d0: last.d0, d1: last.d1, period: last.period },
    },
  ];
}

/** Returns [{ series, meta, points }] for store.saveSeriesPoints. */
export async function fetchSeries() {
  let pts;
  try {
    pts = await fetchHome();
  } catch {
    return [];
  }
  if (!pts.length) return [];
  return [
    { series: `${id}:${HOME.key}:d1`, meta: { label: `${HOME.name} % in drought (D1+)`, unit: "% area", category: "drought" }, points: pts.map((p) => ({ period: p.period, value: p.d1 })) },
    { series: `${id}:${HOME.key}:d0`, meta: { label: `${HOME.name} % abnormally dry+ (D0+)`, unit: "% area", category: "drought" }, points: pts.map((p) => ({ period: p.period, value: p.d0 })) },
  ];
}
