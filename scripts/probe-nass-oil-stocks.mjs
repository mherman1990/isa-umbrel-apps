#!/usr/bin/env node
// probe-nass-oil-stocks.mjs — v2: ENUMERATE the NASS vocabulary instead of guessing it.
//
// WHY v2. v1 guessed commodity_desc="SOYBEAN OIL" + statisticcat_desc="STOCKS" and every query returned
// HTTP 400 {"error":["bad request - invalid query"]}. NASS returns that SAME error both for a
// syntactically valid query that matches ZERO rows AND for an UNRECOGNISED parameter value — so a guess
// is indistinguishable from a wrong descriptor. The fix is to read the exact descriptors NASS actually
// carries (the get_param_values endpoint), then pull a sample with them. Same probe-then-finalise pattern
// as the AMS/CME/Census adapters; still the free-government stand-in for NOPA (Refinitiv-only) — NASS's
// Fats & Oils survey carries soybean-OIL STOCKS + PRODUCTION monthly at a ~45-day lag.
//
// usda_nass already pulls SOYBEAN crush/price/stocks; it does NOT yet pull SOYBEAN OIL stocks/production.
//
// ⚠️ SELF-CONTAINED (Node built-ins only). Reads NASS_API_KEY from /data/.env (where usda_nass reads it):
//
//   sudo docker exec -w /app isa-polibrief_web_1 node scripts/probe-nass-oil-stocks.mjs   # once in an image
//   # or, before it ships, paste it straight in:
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

const API = "https://quickstats.nass.usda.gov/api";

async function call(endpoint, params) {
  const p = new URLSearchParams({ key: KEY, ...params });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(`${API}/${endpoint}/?${p}`, { signal: ctl.signal });
    const body = await res.text();
    let json = null; try { json = JSON.parse(body); } catch {}
    return { status: res.status, json, body };
  } catch (e) {
    return { status: 0, json: null, body: e.message };
  } finally { clearTimeout(timer); }
}

// 1) Which soybean-complex commodities exist, and exactly how are they spelled? (Settles whether NASS even
//    carries soybean OIL as its own commodity, or folds it under SOYBEANS utilization.)
console.log("\n=== 1. commodity_desc in the soybean complex ===");
const cd = await call("get_param_values", { param: "commodity_desc" });
const commodities = cd.json?.commodity_desc ?? [];
const soyish = commodities.filter((c) => /OIL|MEAL|SOYBEAN|CRUSH/i.test(c));
console.log(soyish.length ? soyish.map((c) => `  • ${c}`).join("\n") : `  (none — HTTP ${cd.status} ${String(cd.body).slice(0, 140)})`);

// 2) For the oil/meal commodities, the exact statisticcat_desc + the stock/production short_desc (short_desc
//    is the fully-qualified descriptor — it encodes class_desc + util_practice_desc, the crude/refined/total
//    split we need). get_param_values filtered by commodity_desc returns only values valid for it.
const oilCommodity = soyish.find((c) => /OIL/i.test(c) && !/MEAL/i.test(c));
const targets = [oilCommodity, soyish.find((c) => /MEAL/i.test(c)), soyish.includes("SOYBEANS") ? "SOYBEANS" : null].filter(Boolean);
for (const c of targets) {
  console.log(`\n=== 2. ${c}: statisticcat_desc + stock/production short_desc ===`);
  const sc = await call("get_param_values", { param: "statisticcat_desc", commodity_desc: c });
  console.log(`  statisticcat_desc: ${(sc.json?.statisticcat_desc ?? []).join(" | ") || `(HTTP ${sc.status})`}`);
  const sd = await call("get_param_values", { param: "short_desc", commodity_desc: c });
  const shorts = sd.json?.short_desc ?? [];
  const interesting = shorts.filter((s) => /STOCK|PRODUCTION|PRODUCED|CRUSHED/i.test(s));
  console.log(`  short_desc (${shorts.length} total; stock/production-ish):`);
  for (const s of (interesting.length ? interesting : shorts).slice(0, 30)) console.log(`     ${interesting.length ? "•" : "·"} ${s}`);
}

// 3) Sample DATA for the most promising oil short_desc, so period/unit/Value/freq shape is visible in the
//    same run — that's everything usda_nass needs to add nass:us:soyoil-stocks / :soyoil-production.
console.log("\n=== 3. sample data pulls (NATIONAL, recent) ===");
const yearGE = new Date().getUTCFullYear() - 1;
const oilShorts = [];
if (oilCommodity) {
  const sd = await call("get_param_values", { param: "short_desc", commodity_desc: oilCommodity });
  for (const s of sd.json?.short_desc ?? []) if (/STOCK|PRODUCTION/i.test(s)) oilShorts.push(s);
}
if (!oilShorts.length) console.log(`  (no SOYBEAN OIL stock/production short_desc found — see §1: soybean oil may live under SOYBEANS utilization)`);
for (const s of oilShorts.slice(0, 5)) {
  const r = await call("api_GET", { short_desc: s, agg_level_desc: "NATIONAL", year__GE: String(yearGE), format: "JSON" });
  const rows = r.json?.data ?? [];
  console.log(`\n  "${s}"  → HTTP ${r.status}, ${rows.length} rows`);
  for (const row of rows.slice(0, 3)) {
    console.log(`     ${row.year} ${row.reference_period_desc} = ${row.Value} ${row.unit_desc} (freq ${row.freq_desc}; class ${row.class_desc}; util ${row.util_practice_desc})`);
  }
}

console.log("\n────────────────────────────────────────────────────────");
console.log("Paste this back: the exact commodity_desc + short_desc for soybean-OIL STOCKS and PRODUCTION");
console.log("(plus the unit_desc/freq_desc from §3) lets usda_nass add nass:us:soyoil-stocks / :soyoil-production —");
console.log("the free NASS stand-in for NOPA's oil data. If §1 shows no oil commodity, we pivot to the SOYBEANS");
console.log("utilization split (or the ERS Oil Crops Yearbook) instead.\n");
process.exit(0);
