#!/usr/bin/env node
// check-market-feeds.mjs — LIVE sanity check for the daily price / basis / crush-margin feeds
// added alongside the crush-utilization signal work.
//
// Unlike scripts/verify-legiscan.mjs (which stubs fetch and runs offline), this one deliberately
// hits the real endpoints: the whole point of these two adapters is that they reach keyless or
// already-keyed services, and the failure mode worth catching is "the upstream shape changed."
//
// Run from the repo root:   node scripts/check-market-feeds.mjs
// On the Pi:                sudo docker exec -w /app isa-polibrief_web_1 node scripts/check-market-feeds.mjs
//
// Exit code 0 = every check passed. Non-zero = at least one failed (see the ✗ lines).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

// Load .env exactly the way src/index.js does — DATA_DIR first, then the project root:
//   dotenv.config({ path: [DATA_DIR/.env, PROJECT_ROOT/.env] })
//
// ⚠️ Getting this wrong produced a false failure on the Pi. This script originally read only
// `<repo>/.env`, which is correct for local dev but is `/app/.env` inside the container — the real
// file lives on the mounted data volume at `/data/.env`. The result was
// "✗ USDA_AMS_API_KEY is not set" on a Pi where the key was set the whole time and the app itself
// was reading it fine. A checker that reports a phantom failure is worse than no checker.
function loadEnv() {
  const dataDir = process.env.POLIBRIEF_DATA_DIR ? path.resolve(process.env.POLIBRIEF_DATA_DIR) : ROOT;
  const env = { ...process.env };
  for (const p of [path.join(dataDir, ".env"), path.join(ROOT, ".env")]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      if (!line.includes("=") || line.trim().startsWith("#")) continue;
      const i = line.indexOf("=");
      const k = line.slice(0, i).trim();
      // First file wins, matching dotenv's precedence (DATA_DIR overrides the project root).
      if (!(k in env)) env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

let pass = 0;
let fail = 0;
const ok = (msg) => { console.log(`  ✓ ${msg}`); pass++; };
const bad = (msg) => { console.log(`  ✗ ${msg}`); fail++; };
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));

const env = loadEnv();
const fmtSeries = (s) => {
  const p = s.points;
  return `${s.series.padEnd(30)} ${String(p.length).padStart(5)} pts  ${p[0].period} → ${p[p.length - 1].period}  latest=${p[p.length - 1].value} ${s.meta.unit}`;
};
const find = (out, name) => out.find((s) => s.series === name);
const at = (pts, period) => pts.find((p) => p.period === period)?.value ?? null;

// ---------------------------------------------------------------- CBOT (keyless)
console.log("\n=== cbot_futures (keyless: Yahoo chart endpoint) ===");
let cbotOut = [];
try {
  const cbot = await imp("src/adapters/cbot_futures.js");
  cbotOut = await cbot.fetchSeries({ sourceConfig: {} });
  for (const s of cbotOut) console.log(`     ${fmtSeries(s)}`);

  check(cbotOut.length >= 5, `emitted ${cbotOut.length} series (expect 6: 4 legs + board margin + soy:corn)`);
  for (const name of ["cbot:zs:front", "cbot:zm:front", "cbot:zl:front", "cbot:zc:front", "cbot:crush:board-margin", "cbot:soy-corn:ratio"]) {
    check(!!find(cbotOut, name), `series present: ${name}`);
  }
  const beans = find(cbotOut, "cbot:zs:front");
  if (beans) {
    check(beans.points.length > 800, `soybean history is deep enough for percentiles/lead-lag (${beans.points.length} pts, want >800)`);
    const last = beans.points[beans.points.length - 1];
    // Sanity band, not a forecast: CBOT beans have traded roughly 800–1800¢ for two decades.
    check(last.value > 600 && last.value < 2500, `soybean settle in a plausible band (${last.value}¢/bu on ${last.period})`);
    const ageDays = (Date.now() - Date.parse(last.period)) / 864e5;
    check(ageDays < 7, `soybean settle is fresh (${ageDays.toFixed(1)} days old — weekends/holidays make >4 normal, >7 suspicious)`);
    check(beans.points.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.period)), "every soybean period is a well-formed YYYY-MM-DD");
    const periods = beans.points.map((p) => p.period);
    check(periods.length === new Set(periods).size, "no duplicate soybean periods");
    check(periods.every((p, i) => i === 0 || p > periods[i - 1]), "soybean points are strictly ascending by period");
  }
  const marg = find(cbotOut, "cbot:crush:board-margin");
  if (marg) {
    const last = marg.points[marg.points.length - 1];
    // A negative board crush margin is possible but rare and newsworthy; wildly large means a
    // unit error (e.g. treating ¢/lb oil as $/lb, which would inflate the oil leg ~100×).
    check(last.value > -3 && last.value < 12, `board crush margin plausible ($${last.value.toFixed(2)}/bu on ${last.period}) — a huge value means a unit slip`);
    // Cross-check against the Gordon Denny workbook's own 2026-07-15 board inputs.
    // 319.10*0.0221 + 0.729*11.710 + 140*0.0018 - 12.020 = 3.824
    const jul15 = at(marg.points, "2026-07-15");
    if (jul15 != null) {
      const delta = Math.abs(jul15 - 3.824);
      check(delta < 0.75, `2026-07-15 board margin $${jul15.toFixed(3)} is within $0.75 of the workbook's $3.824 (Δ $${delta.toFixed(3)}; front-month continuous vs his explicit contracts explains a small gap)`);
    } else {
      console.log("     (no 2026-07-15 point — skipping the workbook cross-check)");
    }
  }
} catch (err) {
  bad(`cbot_futures threw: ${err.message}`);
}

// ---------------------------------------------------------------- AMS (needs USDA_AMS_API_KEY)
console.log("\n=== usda_ams (needs USDA_AMS_API_KEY) ===");
if (!env.USDA_AMS_API_KEY) {
  bad("USDA_AMS_API_KEY is not set — cannot check the basis / cash-margin feeds");
} else {
  try {
    const ams = await imp("src/adapters/usda_ams.js");
    // skipBackfill: this script inspects shape and never persists, so letting it trigger the ~6-year
    // chunked backfill means the history is fetched, discarded, and then fetched all over again by
    // the market-refresh that follows. Observed exactly that on the first Pi deploy.
    const out = await ams.fetchSeries({ env, sourceConfig: { skipBackfill: true } });
    for (const s of out) console.log(`     ${fmtSeries(s)}`);

    for (const name of ["ams:ia:cash-price", "ams:ia:basis", "ams:ia:basis-processor", "ams:ia:meal", "ams:ia:oil", "ams:ia:cash-crush-margin"]) {
      check(!!find(out, name), `series present: ${name}`);
    }
    check(!!(find(out, "ams:ia:hulls-loose") || find(out, "ams:ia:hulls-pellet")), "series present: at least one hulls series (loose or pellet)");

    // NOTE ON DEPTH CHECKS: usda_ams deep-pulls only until a series is populated, then returns a
    // ~45-day rolling window. So history depth must be asserted against the STORE, not against the
    // fetch result — checking the fetch was the original mistake here and failed once backfill was
    // complete, which is exactly backwards from a real fault.
    const store = await imp("src/store.js");
    const stored = (name) => { try { return store.getSeries(name).length; } catch { return 0; } };

    const cash = find(out, "ams:ia:cash-price");
    if (cash) {
      const last = cash.points[cash.points.length - 1];
      check(last.value > 4 && last.value < 30, `Iowa cash soybean price plausible ($${last.value.toFixed(2)}/bu on ${last.period})`);
      check(cash.points.length > 0, `incremental fetch returned recent cash points (${cash.points.length})`);
      const n = stored("ams:ia:cash-price");
      check(n > 500 || n === 0, `stored daily cash history is deep (${n} pts in the DB${n === 0 ? " — nothing stored yet; run `node src/index.js market-refresh` to backfill, then re-run this check" : ""})`);
    }
    const basis = find(out, "ams:ia:basis");
    if (basis) {
      const last = basis.points[basis.points.length - 1];
      // Iowa soybean basis is normally negative (country bids under the board) and rarely
      // outside ±200¢. A positive value is possible at processors in a squeeze.
      check(last.value > -300 && last.value < 150, `Iowa basis plausible (${last.value.toFixed(1)}¢/bu on ${last.period})`);
    }
    const proc = find(out, "ams:ia:basis-processor");
    if (proc && basis) {
      const d = proc.points[proc.points.length - 1].period;
      const p = at(proc.points, d);
      const a = at(basis.points, d);
      if (p != null && a != null) ok(`processor vs all-Iowa basis on ${d}: ${p.toFixed(1)} vs ${a.toFixed(1)}¢ (spread ${(p - a).toFixed(1)}¢ — positive = crushers bidding up to pull beans)`);
    }
    const ccm = find(out, "ams:ia:cash-crush-margin");
    if (ccm) {
      const last = ccm.points[ccm.points.length - 1];
      check(last.value > -3 && last.value < 12, `Iowa cash crush margin plausible ($${last.value.toFixed(2)}/bu on ${last.period})`);
      const nm = stored("ams:ia:cash-crush-margin");
      check(nm > 50 || nm === 0, `stored cash margin has usable history (${nm} weekly pts in the DB; 0 = not yet refreshed)`);
      // The cash margin should sit in the same neighbourhood as the board margin, not an order
      // of magnitude away — that's the check that catches a yield-coefficient or unit mistake.
      const bm = find(cbotOut, "cbot:crush:board-margin");
      if (bm) {
        const bmNear = bm.points.filter((p) => p.period <= last.period).slice(-1)[0];
        if (bmNear) {
          const gap = Math.abs(last.value - bmNear.value);
          check(gap < 4, `cash margin $${last.value.toFixed(2)} is within $4 of board margin $${bmNear.value.toFixed(2)} (Δ $${gap.toFixed(2)}) — a large gap means a unit or yield error`);
        }
      }
      console.log("     last 6 weekly cash crush margins:");
      for (const p of ccm.points.slice(-6)) console.log(`       ${p.period}  $${p.value.toFixed(3)}/bu`);
    }
  } catch (err) {
    bad(`usda_ams threw: ${err.message}`);
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
