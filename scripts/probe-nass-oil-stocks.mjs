#!/usr/bin/env node
// probe-nass-oil-stocks.mjs — pin the NASS Fats & Oils shape for the row-8 "soybean-oil stocks" read.
//
// WHY THIS EXISTS. NOPA's monthly crush report (row 8) is the timely source (~15th, prior month), but
// NOPA distributes it EXCLUSIVELY through Refinitiv (paid) — the nopa.org page says so outright and the
// newsroom carries no numbers, so it is NOT available to a free/keyless stack. The free-government
// equivalent is USDA NASS's Fats & Oils survey (Oilseed Crushings, Production, Consumption & Stocks),
// which carries soybean-OIL STOCKS + PRODUCTION monthly — the piece the plan actually wants ("oil stocks
// drive the oil share of crush value") — just at NASS's ~45-day lag instead of NOPA's ~15 days.
//
// usda_nass already pulls SOYBEAN crush/price/stocks; it does NOT yet pull SOYBEAN OIL stocks/production.
// The exact QuickStats vocabulary (commodity_desc spelling, and how crude vs once-refined vs total split
// across class_desc / util_practice_desc / short_desc) can't be seen from dev (QuickStats needs a key),
// so this dumps it from the Pi. Paste the output back and the series get added to usda_nass with the
// right filtering (crude + total), the same probe-then-finalize pattern as the CME/Census adapters.
//
// ⚠️ SELF-CONTAINED (Node built-ins only). Reads NASS_API_KEY from /data/.env (where usda_nass reads it):
//
//   cat scripts/probe-nass-oil-stocks.mjs | sudo docker exec -i isa-polibrief_web_1 node --input-type=module -

import fs from "node:fs";

function loadEnv() {
  const env = { ...process.env };
  for (const p of ["/data/.env", "/app/.env"]) {
    try {
      for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
        const i = line.indexOf("=");
        if (i < 0 || line.trim().startsWith("#")) continue;
        const k = line.slice(0, i).trim();
        if (!(k in env)) env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      }
    } catch { /* file may not exist */ }
  }
  return env;
}
const env = loadEnv();
const KEY = env.NASS_API_KEY;
if (!KEY) {
  console.log("NASS_API_KEY not set — usda_nass already uses it, so it should be in /data/.env");
  process.exit(0);
}

const BASE = "https://quickstats.nass.usda.gov/api/api_GET/";
const yearGE = new Date().getUTCFullYear() - 2;

async function grab(params) {
  const p = new URLSearchParams({ key: KEY, format: "JSON", year__GE: String(yearGE), agg_level_desc: "NATIONAL", ...params });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(`${BASE}?${p}`, { signal: ctl.signal });
    const body = await res.text();
    let json = null; try { json = JSON.parse(body); } catch {}
    return { status: res.status, rows: json?.data ?? [], body };
  } catch (e) {
    return { status: 0, rows: [], body: e.message };
  } finally { clearTimeout(timer); }
}

// Distinct descriptors + the newest few monthly values, so we can see exactly which rows are crude vs
// refined vs total and how the period is encoded.
function dump(label, rows) {
  console.log(`\n  ${label}: HTTP rows=${Array.isArray(rows) ? rows.length : 0}`);
  if (!Array.isArray(rows) || !rows.length) return;
  const kinds = new Map();
  for (const r of rows) {
    const k = `${r.short_desc} | class=${r.class_desc} | util=${r.util_practice_desc} | unit=${r.unit_desc} | freq=${r.freq_desc}`;
    if (!kinds.has(k)) kinds.set(k, []);
    if (kinds.get(k).length < 2) kinds.get(k).push(`${r.year} ${r.reference_period_desc}=${r.Value}`);
  }
  for (const [k, samples] of [...kinds].slice(0, 25)) console.log(`    • ${k}  →  ${samples.join("; ")}`);
}

for (const [name, params] of [
  ["SOYBEAN OIL / STOCKS", { commodity_desc: "SOYBEAN OIL", statisticcat_desc: "STOCKS" }],
  ["SOYBEAN OIL / PRODUCTION", { commodity_desc: "SOYBEAN OIL", statisticcat_desc: "PRODUCTION" }],
  ["SOYBEAN OIL / STOCKS (short_desc contains OIL, alt spelling check)", { commodity_desc: "SOYBEANS", statisticcat_desc: "STOCKS", util_practice_desc: "OIL" }],
  ["SOYBEAN MEAL / STOCKS (bonus — meal share)", { commodity_desc: "SOYBEAN MEAL", statisticcat_desc: "STOCKS" }],
]) {
  const r = await grab(params);
  if (r.status !== 200 && !r.rows.length) console.log(`\n  ${name}: HTTP ${r.status} — ${String(r.body).slice(0, 160)}`);
  else dump(name, r.rows);
}

console.log("\n────────────────────────────────────────────────────────");
console.log("Paste this back: the exact short_desc / class_desc / unit_desc for soybean-OIL STOCKS (crude +");
console.log("total) + PRODUCTION lets usda_nass add nass:us:soyoil-stocks / :soyoil-production with the right");
console.log("filtering — the free NASS stand-in for NOPA's oil data (NOPA itself is Refinitiv-only).\n");
process.exit(0);
