// triggers.js — the BeanBrief condition-trigger engine.
//
// Evaluates the marketing condition triggers (src/data/condition_triggers.json) against today's
// date + our stored market data + the report calendar, applies the suppress_if / guardrail rules,
// and ranks the fired triggers by priority for the education-card synthesis. See
// docs/BEANBRIEF_MARKETING_CONTEXT.md (the domain + compliance bible) §1, §5, §7.
//
// This is EDUCATION plumbing: it decides which teachable market states are active. The compliant
// card copy is written downstream (pipeline.generateMarketCards) with the guardrails in compliance.js.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as store from "./store.js";
import { nextImpactfulReport } from "./calendar.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
let CFG = null;
function load() {
  if (CFG) return CFG;
  try {
    CFG = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "condition_triggers.json"), "utf8"));
  } catch {
    CFG = { triggers: [] };
  }
  return CFG;
}

const mmdd = (d) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

/** Parse "today BETWEEN 'MM-DD' AND 'MM-DD'" out of the (documentary) expression, or null. */
function dateWindow(expr, now) {
  const m = /BETWEEN '(\d{2}-\d{2})' AND '(\d{2}-\d{2})'/.exec(expr || "");
  if (!m) return null;
  const t = mmdd(now), a = m[1], b = m[2];
  return a <= b ? t >= a && t <= b : t >= a || t <= b; // tolerate a year-wrap window
}

const round = (v) => (v == null ? "—" : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Math.round(v * 100) / 100);

// Triggers whose firing depends on live data (beyond the date window). Others are date-only.
const DATA_TRIGGERS = new Set(["cot_managed_money_extreme", "pre_report_positioning", "harvest_strong_anomaly", "basis_carry_state"]);

function dataFires(id, now, snap) {
  if (id === "cot_managed_money_extreme") {
    const s = snap.get("cftc:soybeans:mm-net");
    if (!s) return { ok: false };
    const flip = s.previous && Math.sign(s.latest.value) !== Math.sign(s.previous.value) && s.previous.value !== 0;
    const ok = s.percentile >= 90 || s.percentile <= 10 || flip;
    return { ok, detail: `Managed-money net ${round(s.latest.value)} contracts, ${s.percentile}th percentile${flip ? ", just flipped long/short" : ""} (CFTC, ${s.latest.period}).` };
  }
  if (id === "pre_report_positioning") {
    const next = nextImpactfulReport("very_high", 10, now);
    if (!next) return { ok: false };
    const days = Math.ceil((Date.parse(next.date + "T12:00:00Z") - now.getTime()) / 86400e3);
    return { ok: days >= 1 && days <= 5, detail: `${next.name} is ${days} day${days === 1 ? "" : "s"} out (${next.date}).` };
  }
  if (id === "harvest_strong_anomaly") {
    // Date-gated to Sep–Nov already; proxy the "tight balance sheet" leg with low stocks percentile.
    const stocks = snap.get("nass:us:stocks");
    return { ok: stocks ? stocks.percentile <= 35 : false, detail: stocks ? `U.S. stocks at the ${stocks.percentile}th percentile — a tighter balance sheet.` : "" };
  }
  if (id === "basis_carry_state") {
    return { ok: false, detail: "" }; // needs a futures carry spread (CME blocked) — off until a futures feed lands
  }
  return { ok: true };
}

function describe(id, snap) {
  if (id === "china_demand_clock") {
    const es = snap.get("agtransport:soy-net-export-sales");
    return es ? `Latest weekly soybean net export sales ${round(es.latest.value)} MT (${es.latest.period})${es.yoyPct != null ? `, ${es.yoyPct >= 0 ? "+" : ""}${es.yoyPct.toFixed(0)}% vs. a year ago` : ""}.` : "";
  }
  return "";
}

/**
 * Evaluate all condition triggers for `now`. Returns the fired triggers, ranked (lowest priority
 * number first), after applying each trigger's suppress_if (so the harvest-strong guardrail
 * softens its seasonal cards).
 * @returns {{ id, name, category, card_type, priority, history_note, detail }[]}
 */
export function evaluateTriggers(now = new Date()) {
  const cfg = load();
  const snap = new Map(store.marketSnapshot().map((s) => [s.series, s]));
  const fired = [];
  for (const t of cfg.triggers) {
    const win = dateWindow(t.fire_when?.expression, now);
    if (win === false) continue; // has a date window and we're outside it
    let detail = describe(t.id, snap);
    if (DATA_TRIGGERS.has(t.id)) {
      const d = dataFires(t.id, now, snap);
      if (!d.ok) continue;
      detail = d.detail || detail;
    }
    fired.push({ id: t.id, name: t.name, category: t.category, card_type: t.card_type, priority: t.priority ?? 5, history_note: t.history_note, suppress_if: t.suppress_if || [], detail });
  }
  const activeIds = new Set(fired.map((f) => f.id));
  return fired
    .filter((f) => !f.suppress_if.some((s) => activeIds.has(s)))
    .sort((a, b) => a.priority - b.priority)
    .map(({ suppress_if, ...rest }) => rest); // drop the internal field
}

/** Compact text of the fired triggers for the card-synthesis + Pulse prompts. */
export function triggersText(now = new Date()) {
  const fired = evaluateTriggers(now);
  if (!fired.length) return "";
  return fired
    .map((f) => `- [${f.card_type}, priority ${f.priority}] ${f.name}: ${f.history_note}${f.detail ? ` (current data: ${f.detail})` : ""}`)
    .join("\n");
}
