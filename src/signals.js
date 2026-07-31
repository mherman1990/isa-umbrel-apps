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
import { crushSignal } from "./crush.js";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthOf = (period) => MON[(Number(String(period).slice(5, 7)) || 1) - 1];
const pctStr = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
const round = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Math.round(v * 100) / 100);
// Correct ordinal suffix (92nd, 21st, 33rd) — percentile labels are farmer-facing.
const ordinal = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`; };

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

// Satellite vegetation condition — the leading companion to Crop Condition. VegScape VCI is a
// 0–100 index of crop vigor vs. each pixel's own 2000-present range, published ~4 days after each
// week closes → it front-runs the Monday NASS G/E rating. Low VCI = vegetation stress = a supply-
// risk read that supports price; high VCI = a lush crop that weighs on it. Growing-season only
// (off-season the cropland mask sees bare soil/residue, not the crop).
function vegCondition(m) {
  const s = m.get("vegscape:ia:vci");
  if (!s || !isFresh(s, 21)) return null; // weekly; a stale series drops off
  const mon = new Date().getUTCMonth() + 1;
  if (mon < 4 || mon > 10) return null; // Apr–Oct — otherwise not the standing crop
  const v = s.latest.value;
  const direction = v <= 40 ? "bullish" : v >= 65 ? "bearish" : "neutral";
  const trend = s.changeAbs == null ? "" : ` ${s.changeAbs >= 0 ? "▲" : "▼"}${Math.abs(Math.round(s.changeAbs))}pts wk/wk.`;
  return {
    id: "veg_condition", name: "Crop Vegetation (VCI)", direction, value: v,
    label: `${Math.round(v)}/100 VCI`,
    detail: `Iowa satellite VCI ${Math.round(v)}/100 (${s.latest.period}) — crop vigor vs. its 2000-present range.${trend} ${direction === "bullish" ? "Stressed vegetation (low VCI) is a supply-risk read that supports price, often ahead of the USDA condition rating." : direction === "bearish" ? "A vigorous crop (high VCI) points to good yield potential and weighs on price." : "Vegetation near the middle of its historical range."}`,
  };
}

// Root-zone soil moisture — the CAUSE-side companion to VCI (the effect) and the weather inputs.
// Crop-CASMA / NASA SMAP measures the water actually available to the crop's roots. We store the
// absolute value and read the seasonal anomaly (vs. the same-week-of-year normal) computed in-app;
// until a cross-year baseline exists, fall back to the recent multi-week trajectory. Dry = supply
// risk = supportive of price; a well-charged profile weighs on it. Growing-season only.
function soilMoisture(m) {
  const s = m.get("cropcasma:ia:rootzone-sm");
  if (!s || !isFresh(s, 21)) return null;
  const mon = new Date().getUTCMonth() + 1;
  if (mon < 4 || mon > 10) return null;
  let deltaPct = null, basis = null;
  if (s.seasonalDeltaPct != null) {
    deltaPct = s.seasonalDeltaPct; basis = "vs. the seasonal norm";
  } else if (s.trail && s.trail.length >= 5) {
    // recent trajectory: latest vs. the mean of the prior ~4 weeks
    const t = s.trail.map((p) => p.value);
    const latest = t[t.length - 1];
    const prior = t.slice(-5, -1);
    const base = prior.reduce((a, b) => a + b, 0) / prior.length;
    if (base) { deltaPct = ((latest - base) / base) * 100; basis = "vs. the last few weeks"; }
  }
  if (deltaPct == null) return null;
  const direction = deltaPct <= -8 ? "bullish" : deltaPct >= 8 ? "bearish" : "neutral";
  return {
    id: "soil_moisture", name: "Root-Zone Soil Moisture", direction, value: s.latest.value,
    label: `${pctStr(deltaPct)} ${basis === "vs. the seasonal norm" ? "vs norm" : "trend"}`,
    detail: `Iowa root-zone soil moisture ${s.latest.value.toFixed(3)} m³/m³ (${s.latest.period}), ${pctStr(deltaPct)} ${basis}. ${direction === "bullish" ? "A drying root zone in-season is supply risk that supports price — often ahead of the crop's visible response." : direction === "bearish" ? "A well-charged root zone buffers the crop and weighs on price." : "Root-zone moisture near normal for the window."}`,
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
    label: `${ordinal(p)} pctile`,
    detail: `CBOT managed-money net ${round(s.latest.value)} contracts (${s.latest.period}) — ${ordinal(p)} percentile of its range. ${direction === "bullish" ? "Funds leaning long." : direction === "bearish" ? "Funds leaning short — crowded shorts can cover." : "Funds near neutral."}`,
  };
}

// RETIRED — replaced by crush.js `crushSignal()` (capacity utilization).
//
// Kept only as a documented cautionary example, deliberately NOT on the board. It ranked crush
// VOLUME against full history and fired bullish above the 80th percentile. Because capacity grew
// ~1.06M bu/day from March 2023 to May 2026, volume ratchets to a fresh record most years no matter
// what demand is doing, so this printed "BULLISH — record-strong domestic demand" for eight straight
// months while crush itself fell ~10%. It also had no freshness guard, so it kept voting on
// two-month-old NASS data. If you are tempted to re-add a level-percentile scorer for any series
// with a structural trend, read this comment first: rank the CHANGE, or rank against capacity, or
// use a rolling window — never the full-history level.
// eslint-disable-next-line no-unused-vars
function crushDemand_RETIRED(m) {
  const s = m.get("nass:us:crush");
  if (!s || s.percentile == null) return null;
  const p = s.percentile;
  const direction = p >= 80 ? "bullish" : p <= 25 ? "bearish" : "neutral";
  return {
    id: "crush_demand", name: "Crush Demand", direction, value: p,
    label: `${ordinal(p)} pctile`,
    detail: `U.S. crush ${round(s.latest.value)} (${s.latest.period}), ${s.yoyPct != null ? pctStr(s.yoyPct) + " YoY, " : ""}${ordinal(p)} percentile of its range.`,
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
    label: `${ordinal(p)} pctile`,
    detail: `Broad dollar index ${round(s.latest.value)} (${s.latest.period}), ${ordinal(p)} percentile of its range${s.changePct != null ? `, ${pctStr(s.changePct)} vs. prior` : ""}. ${direction === "bearish" ? "A strong dollar caps U.S. export competitiveness vs. Brazil." : direction === "bullish" ? "A weaker dollar helps U.S. export competitiveness." : "Dollar mid-range."}`,
  };
}

// The acreage-battle read: the soybean:corn price ratio steers spring planting intentions.
function soyCornRatio(m) {
  const s = m.get("nass:ia:soy-corn-ratio");
  if (!s || s.percentile == null || !isFresh(s, 120)) return null;
  const v = s.latest.value, p = s.percentile;
  // A historically HIGH ratio (beans richly priced vs corn) pulls acres toward soybeans, building
  // the next crop's supply (a longer-term weight); a LOW ratio favors corn, so fewer bean acres
  // ahead. That acreage logic only bites in the Dec–Apr decision window — off-season it's context.
  const mon = new Date().getUTCMonth() + 1;
  const inWindow = mon <= 4 || mon === 12;
  const direction = inWindow ? (p >= 75 ? "bearish" : p <= 25 ? "bullish" : "neutral") : "neutral";
  return {
    id: "soy_corn_ratio", name: "Soy:Corn Ratio", direction, value: v,
    label: `${v.toFixed(2)}:1`,
    detail: `Iowa soybeans are ${v.toFixed(2)}× the corn price (${s.latest.period}), ${ordinal(p)} percentile of its range. ${inWindow ? (direction === "bearish" ? "Richly priced vs corn heading into planting — incentivizes soybean acres (supply-building for the new crop)." : direction === "bullish" ? "Corn favored heading into planting — fewer soybean acres ahead can tighten new-crop supply." : "Near the acreage-neutral pivot — planting incentives balanced.") : "Watched most in late winter/spring, when it steers planting intentions."}`,
  };
}

// The farmer-facing signal board. NOTE: feedstockShare (soy-oil's % of biofuel feedstock) and
// dollar (broad USD) are intentionally OFF the board — they're structural / macro-policy reads,
// not signals a grain marketer leads with. Their DATA still shows on the Markets charts and reaches
// the Analyst/Pulse memos via the market-data block, so nothing is lost; they're just not headline
// farmer signals. (The functions are kept above for that context + easy reinstatement.)
const SCORERS = [cropCondition, vegCondition, soilMoisture, exportPace, stocksToUse, fundPositioning, brazilSupply, drought, soyCornRatio];

// --- factor grouping: the tilt must not double-count correlated signals -----------------------
//
// The tilt used to be a raw count: net = bullish − bearish, ±2 flips it. That silently weights by
// HOW MANY SCORERS happen to exist for a variable rather than by how much the variable matters.
// In season, five of the ~13 board slots — crop condition, satellite VCI, root-zone soil moisture,
// Iowa drought and U.S. crop weather — are all reads on the SAME underlying thing: moisture stress
// in the belt. Adding satellite feeds (v1.22/v1.23) made that worse, not better: a single dry spell
// could swing the headline tilt by five votes while the balance sheet, the actual supply/demand
// anchor, contributed one. The board looked more sophisticated and got more lopsided.
//
// So: group scorers into FACTORS, average within a factor, and weight factors. Five agreeing
// weather reads now move the tilt as much as weather should, and no more.
//
// ⚠️ Weights are informed judgement, NOT measured predictive power — they encode how much each
// factor drives soybean price in the analyst's mental model. Once the lead-lag scan (leadlag.js)
// has enough daily price history to measure which factors actually lead price and by how long, these
// should be re-derived from that rather than left as-is. Documented here so nobody mistakes them for
// fitted values. The per-signal board display is unchanged — this only affects the aggregate.
const FACTORS = {
  crop_stress: {
    label: "U.S. crop stress",
    weight: 1.0,
    members: ["crop_condition", "veg_condition", "soil_moisture", "drought", "weather_us"],
    note: "Five correlated reads on one variable — belt moisture/heat stress. Averaged, not summed.",
  },
  balance_sheet: { label: "Balance sheet", weight: 1.0, members: ["stocks_to_use"], note: "Ending stocks as a share of use — the supply/demand anchor." },
  demand_domestic: { label: "Domestic crush demand", weight: 0.9, members: ["crush_utilization"], note: "Capacity utilization — is the installed base pulling beans through." },
  demand_export: { label: "Export demand", weight: 0.9, members: ["export_pace"], note: "Weekly net sales pace vs. a year ago." },
  sa_supply: { label: "S. American supply", weight: 0.8, members: ["brazil_supply", "weather_sa"], note: "Competitor supply — correlated pair (crop size + the weather making it)." },
  positioning: { label: "Fund positioning", weight: 0.5, members: ["fund_positioning"], note: "Flow, not fundamental, and mean-reverting — deliberately half-weight." },
  acreage: { label: "Acreage incentive", weight: 0.4, members: ["soy_corn_ratio"], note: "Next-crop supply; only bites in the Dec–Apr decision window." },
  seasonal: { label: "Seasonal tendency", weight: 0.3, members: ["seasonal"], note: "Calendar tendency only — the weakest evidence on the board." },
};
// Which stored series each scorer actually reads — surfaced in signalsText so the model can't
// misattribute a call to the wrong series (see the note on `lines` in signalsText).
const SIGNAL_SERIES = {
  crop_condition: "nass:us:condition / nass:ia:condition",
  veg_condition: "vegscape:ia:vci",
  soil_moisture: "cropcasma:ia:rootzone-sm",
  drought: "drought_monitor:ia:d1",
  export_pace: "agtransport:soy-net-export-sales (NET SALES — not export inspections)",
  stocks_to_use: "wasde:us:soy-stocks-to-use",
  fund_positioning: "cftc:soybeans:mm-net",
  brazil_supply: "ibge_brazil:soy-production",
  soy_corn_ratio: "nass:ia:soy-corn-ratio",
  seasonal: "nass:us:price (monthly seasonal averages)",
  crush_utilization: "nass:us:crush ÷ crush_capacity.json nameplate",
  weather_us: "open_meteo:us:precip-pctile / heat-pctile",
  weather_sa: "open_meteo:sa:precip-pctile / heat-pctile",
};
const DIR_SCORE = { bullish: 1, bearish: -1, neutral: 0 };
// Weighted net needed to call a tilt. Lower than the old ±2 count because this is a normalized
// −1..+1 scale, not a headcount: 0.15 means the weighted evidence leans meaningfully one way.
const TILT_THRESHOLD = 0.15;

/**
 * Collapse signals into weighted factors so correlated scorers can't dominate the tilt.
 * @returns {{ factors: object[], net: number }} net is normalized to −1..+1 over PRESENT factors.
 */
function factorTilt(signals) {
  const byId = new Map(signals.map((s) => [s.id, s]));
  const factors = [];
  let weighted = 0;
  let weightSum = 0;
  for (const [key, f] of Object.entries(FACTORS)) {
    const present = f.members.map((id) => byId.get(id)).filter(Boolean);
    if (!present.length) continue; // off-season scorers drop out; they don't count as neutral
    const score = present.reduce((a, s) => a + DIR_SCORE[s.direction], 0) / present.length;
    factors.push({
      key,
      label: f.label,
      weight: f.weight,
      score,
      direction: score >= 0.34 ? "bullish" : score <= -0.34 ? "bearish" : "neutral",
      members: present.map((s) => ({ id: s.id, name: s.name, direction: s.direction })),
      note: f.note,
    });
    weighted += f.weight * score;
    weightSum += f.weight;
  }
  // Any scorer not mapped to a factor still gets a voice at low weight, so adding a scorer without
  // touching FACTORS degrades gracefully instead of silently dropping it out of the tilt.
  const mapped = new Set(Object.values(FACTORS).flatMap((f) => f.members));
  for (const s of signals) {
    if (mapped.has(s.id)) continue;
    weighted += 0.3 * DIR_SCORE[s.direction];
    weightSum += 0.3;
    factors.push({ key: s.id, label: s.name, weight: 0.3, score: DIR_SCORE[s.direction], direction: s.direction, members: [{ id: s.id, name: s.name, direction: s.direction }], note: "Unmapped scorer — add it to FACTORS in signals.js to weight it properly." });
  }
  return { factors, net: weightSum ? weighted / weightSum : 0 };
}

/**
 * Compute the current signal board from stored market data.
 * @returns {{ signals, bullish, bearish, neutral, total, tilt, factors, net }}
 */
export function computeSignals() {
  const snapshot = store.marketSnapshot();
  const m = new Map(snapshot.map((s) => [s.series, s]));
  const signals = [...SCORERS.map((fn) => fn(m)), seasonalPrice(), crushSignal(), ...weatherSignals(m)].filter(Boolean);
  const bullish = signals.filter((s) => s.direction === "bullish").length;
  const bearish = signals.filter((s) => s.direction === "bearish").length;
  const neutral = signals.filter((s) => s.direction === "neutral").length;
  const { factors, net } = factorTilt(signals);
  const tilt = net >= TILT_THRESHOLD ? "bullish" : net <= -TILT_THRESHOLD ? "bearish" : "mixed";
  // bullish/bearish/neutral counts are retained for the existing board UI and alert copy; the TILT
  // itself is now the weighted-factor read, so the headline can legitimately differ from the raw
  // headcount (that's the point).
  return { signals, bullish, bearish, neutral, total: signals.length, tilt, factors, net };
}

/**
 * Compact text of the board for the memo/analyst prompts.
 *
 * The FACTOR block matters as much as the signal list: without it the model sees five separate
 * weather-ish bullets and reasonably concludes weather is five independent pieces of evidence.
 * Showing the grouping tells it they're one variable read five ways, and shows which factors are
 * doing the real work in the tilt.
 */
export function signalsText() {
  const { signals, bullish, bearish, neutral, tilt, factors, net } = computeSignals();
  if (!signals.length) return "";
  // Name the SERIES each scorer reads. Without it the first live Analyst Note attributed the NEUTRAL
  // export reading to "a low inspection print" when exportPace actually scores net sales — two
  // similarly-named export series, and the prose gave the model no way to tell which one drove the
  // call. Cheap to state, and it makes the board auditable rather than something to be inferred.
  const lines = signals.map((s) => `- ${s.name}: ${s.direction.toUpperCase()} (${s.label})${SIGNAL_SERIES[s.id] ? ` [scored from ${SIGNAL_SERIES[s.id]}]` : ""} — ${s.detail}`);
  const fLines = factors
    .slice()
    .sort((a, b) => Math.abs(b.weight * b.score) - Math.abs(a.weight * a.score))
    .map((f) => {
      const members = f.members.length > 1 ? ` [${f.members.map((x) => `${x.name}=${x.direction}`).join(", ")}]` : "";
      return `- ${f.label} (weight ${f.weight.toFixed(1)}): ${f.direction.toUpperCase()}, score ${f.score >= 0 ? "+" : ""}${f.score.toFixed(2)}${members}`;
    });
  return (
    `Overall tilt: ${tilt.toUpperCase()} — weighted-factor net ${net >= 0 ? "+" : ""}${net.toFixed(2)} on a −1..+1 scale ` +
    `(raw scorer headcount, for reference only: ${bullish} bullish / ${bearish} bearish / ${neutral} neutral).\n` +
    `The tilt is computed by FACTOR, not by counting scorers, because several scorers measure the same variable — ` +
    `notably five reads on U.S. belt moisture stress, which are averaged into one factor rather than voting five times.\n\n` +
    `FACTORS (most influential first):\n${fLines.join("\n")}\n\n` +
    `INDIVIDUAL SIGNALS:\n${lines.join("\n")}`
  );
}
