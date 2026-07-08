// weather.js — the crop-weather engine for The Bean Brief.
//
// Turns the raw anomaly series (stored by the open_meteo adapter — recent 30-day precip & heat
// vs. ~27yr ERA5 normals, production-weighted per region group) into a PRICE read: dry + hot in a
// growing region during a yield-sensitive window is supply risk, which supports price. South-
// American stress is the competitor-supply mirror — it also supports U.S. price.
//
// The point of this layer (vs. a raw reading): it weights the anomaly by WHEN it lands in the
// crop's life (phenology) and reasons weather -> supply -> price, so the Analyst Note / Ask box
// get a mechanism, not "it's dry in Iowa." Pure engine — reads the stored snapshot, no network.
// Farmer-facing use stays education, never advice.

import * as store from "./store.js";

// Yield-sensitivity by month for U.S. soybeans (N. hemisphere): planting May, vegetative Jun,
// bloom/R1 Jul, POD-FILL/R3–R5 Aug (the most yield-critical window), maturity Sep, harvest Oct.
function usStage(month) {
  if (month === 8) return { sens: 1.0, stage: "pod-fill (the most yield-sensitive window)" };
  if (month === 7 || month === 9) return { sens: 0.8, stage: "the reproductive window" };
  if (month === 6) return { sens: 0.5, stage: "vegetative growth" };
  if (month === 5 || month === 10) return { sens: 0.3, stage: "planting/maturity" };
  return { sens: 0, stage: "the off-season" };
}
// S. hemisphere soybeans: plant Oct–Nov, vegetative Dec, POD-FILL Jan–Feb, harvest Mar–Apr.
function saStage(month) {
  if (month === 1 || month === 2) return { sens: 1.0, stage: "pod-fill" };
  if (month === 12 || month === 3) return { sens: 0.7, stage: "the reproductive/early-fill window" };
  if (month === 11) return { sens: 0.4, stage: "planting" };
  return { sens: 0, stage: "the off-season" };
}

// Combined stress 0–100 from the two percentiles: low precip pctile = dry, high heat pctile = hot.
function stressOf(precipPctile, heatPctile) {
  const dry = 100 - (precipPctile ?? 50);
  const hot = heatPctile ?? 50;
  return Math.round(dry * 0.6 + hot * 0.4);
}

const ord = (n) => `${n}${["th", "st", "nd", "rd"][(n % 100 >> 3 ^ 1) && n % 10] || "th"}`;

function scorer(m, key) {
  const p = m.get(`open_meteo:${key}:precip-pctile`);
  const h = m.get(`open_meteo:${key}:heat-pctile`);
  if (!p && !h) return null;
  const month = new Date().getUTCMonth() + 1;
  const st = key === "us" ? usStage(month) : saStage(month);
  if (st.sens < 0.3) return null; // off-season → keep it off the board rather than mislead
  const precipPctile = Math.round(p?.latest?.value ?? 50);
  const heatPctile = Math.round(h?.latest?.value ?? 50);
  const stress = stressOf(precipPctile, heatPctile);
  const direction = stress >= 62 ? "bullish" : stress <= 38 ? "bearish" : "neutral";
  const name = key === "us" ? "U.S. Crop Weather" : "S. America Weather";
  const where = key === "us" ? "U.S. soybean belt" : "S. American soybean crop";
  const read = direction === "bullish"
    ? (key === "us" ? "Dry/hot stress in a key window is supply-supportive for price." : "Competitor-supply stress shifts demand toward the U.S. — supportive.")
    : direction === "bearish"
      ? (key === "us" ? "Favorable (wet/cool) crop weather weighs on price." : "A benign S. American crop weighs on U.S. price.")
      : "Weather near normal for the window.";
  return {
    id: `weather_${key}`, name, direction, value: stress,
    label: `${ord(precipPctile)} precip`,
    detail: `${where}: 30-day precipitation at the ${ord(precipPctile)} percentile and heat at the ${ord(heatPctile)}, during ${st.stage}. ${read}`,
  };
}

/** Weather scorers for the signals board, given the snapshot map. Off-season regions drop out. */
export function weatherSignals(m) {
  return [scorer(m, "us"), scorer(m, "sa")].filter(Boolean);
}

/** Narrative for the Analyst Note / Market Pulse / Ask box — the weather→supply→price read. */
export function weatherRiskText() {
  const m = new Map(store.marketSnapshot().map((s) => [s.series, s]));
  const sigs = weatherSignals(m);
  if (!sigs.length) return "";
  return sigs.map((s) => `- ${s.name}: ${s.direction.toUpperCase()} — ${s.detail}`).join("\n");
}
